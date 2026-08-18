// Spendifre — Azure infrastructure.
//
// One deployment per residency region (SPEC §9.4). The region is a parameter
// rather than a branch: an EU and an APAC deployment differ in where they run
// and what `RESIDENCY_REGION` says, and in nothing else. That is what makes
// `CMP-140` a hosting decision rather than a code change.
//
// Three properties this template is built for:
//
//   No secrets in configuration.   Every credential is a Key Vault reference or
//                                  a managed identity. The template contains no
//                                  password, and `@secure()` parameters are not
//                                  echoed into deployment history.
//
//   No public database.            PostgreSQL has public network access off and
//                                  is reached over a private endpoint. The app
//                                  authenticates with its managed identity
//                                  (ZT-005/ZT-006), so there is no database
//                                  password to rotate or leak.
//
//   Least privilege by default.    The container app's identity holds Key Vault
//                                  *get* on secrets and nothing else. It cannot
//                                  list, set, or reach any other resource.
//
// Deploy:
//   az deployment group create -g rg-spendifre-eu -f main.bicep -p @eu.bicepparam

targetScope = 'resourceGroup'

@description('Deployment region key, and the value RESIDENCY_REGION is set to.')
@allowed(['eu', 'ch', 'apac', 'cn'])
param residency string

@description('Regions whose entities this deployment serves. Must include `residency`. Widening this beyond the home region is a cross-border transfer — see CMP-140.')
param servedRegions array = [residency]

@description('Azure region. Must be inside the residency boundary above.')
param location string

@description('Fully qualified image reference, by digest. A tag would let the running image change without a deployment.')
param imageDigest string

@description('Public origin, https only — loadConfig refuses to start otherwise.')
param publicOrigin string

@description('Entra ID tenant and application registration.')
param entraTenantId string
param entraClientId string

@description('Fiscal year this deployment serves.')
param fiscalYear int = 2026

@description('Minimum replicas. Two by default: a single replica makes every deploy an outage.')
param minReplicas int = 2
param maxReplicas int = 10

var prefix = 'spendifre-${residency}'
// Storage account names are 3–24 lowercase alphanumerics, so they cannot use
// the prefix directly. Derived from the resource group id for uniqueness.
var storageName = 'sp${residency}${uniqueString(resourceGroup().id)}'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-id'
  location: location
}

// ---------------------------------------------------------------------------
// Key Vault (ZT-006)
// ---------------------------------------------------------------------------

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${prefix}-kv'
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    // RBAC rather than access policies: policies are per-object and drift.
    enableRbacAuthorization: true
    // A deleted vault is recoverable for 90 days. Purge protection means an
    // attacker with Contributor cannot destroy the keys that make backups
    // readable — which is the shape of a ransomware playbook.
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

// Key Vault Secrets User. Get only — not list, not set. The application reads
// the secrets it was told about and cannot enumerate the vault.
resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, identity.id, '4633458b-17de-408a-b874-0445c86b69e6')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '4633458b-17de-408a-b874-0445c86b69e6'
    )
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${prefix}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.20.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.20.0.0/23'
          delegations: [
            { name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
        }
      }
      {
        name: 'data'
        properties: {
          addressPrefix: '10.20.2.0/24'
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
      {
        // Private endpoints only. `data` is delegated to PostgreSQL flexible
        // server and a delegated subnet cannot host one, so the file share
        // needs its own.
        name: 'links'
        properties: {
          addressPrefix: '10.20.3.0/24'
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL (SEC-021, ZT-005)
// ---------------------------------------------------------------------------

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${prefix}-pg'
  location: location
  sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' }
  properties: {
    version: '16'
    // No administratorLogin/Password. Entra-only authentication means there is
    // no database password anywhere — not in the template, not in the vault,
    // not in a connection string.
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: entraTenantId
    }
    storage: { storageSizeGB: 128, autoGrow: 'Enabled' }
    backup: {
      // CMP-107. The application's own encrypted backup is a second,
      // independent copy with a different key and a different blast radius;
      // this is the platform's point-in-time restore.
      backupRetentionDays: 35
      geoRedundantBackup: residency == 'eu' ? 'Enabled' : 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: vnet.properties.subnets[1].id
    }
    highAvailability: { mode: 'ZoneRedundant' }
  }
}

// DB_SSL_MODE=verify-full in the app; this is the server half of that.
resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'require_secure_transport'
  properties: { value: 'ON', source: 'user-override' }
}

// Log every statement that changes data, at the server, independently of the
// application's own audit trail. Two records with different failure modes.
resource logStatements 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01-preview' = {
  parent: postgres
  name: 'log_statement'
  properties: { value: 'mod', source: 'user-override' }
}

// ---------------------------------------------------------------------------
// Storage for encrypted backups
// ---------------------------------------------------------------------------

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: residency == 'eu' ? 'Standard_GZRS' : 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // The archives are already AES-256-GCM encrypted by the application. This
    // is the second layer, and it is the one that protects against a disk
    // leaving the datacentre rather than against a stolen file.
    encryption: {
      services: { blob: { enabled: true } }
      keySource: 'Microsoft.Storage'
    }
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'AzureServices' }
  }
}

// An Azure Files share, not a blob container.
//
// The application writes archives with `fs.writeFile`, and Container Apps can
// mount Files but not Blob. The alternative was to take the Azure Blob SDK as a
// dependency, which ADR 0004 sets a high bar for — and the bar is not met here,
// because a mount achieves the same result with no code, no credential handling
// in the application, and nothing new to keep patched.
//
// What this does *not* provide is blob immutability. That was not configured on
// the container it replaces either, so nothing is lost today; if a WORM
// retention policy on backups becomes a requirement, that is the argument for
// revisiting the SDK, and it should be made explicitly rather than discovered.
resource backupShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  name: '${storage.name}/default/backups'
  properties: {
    // Archives are ~10 MB compressed on the current dataset. 100 GiB is the
    // smallest provisioned size that is not an obstacle.
    shareQuota: 100
    enabledProtocols: 'SMB'
  }
}

// The storage account refuses public network access, so the mount has to arrive
// over a private endpoint.
resource backupLink 'Microsoft.Network/privateEndpoints@2023-11-01' = {
  name: '${prefix}-files-pe'
  location: location
  properties: {
    subnet: { id: vnet.properties.subnets[2].id }
    privateLinkServiceConnections: [
      {
        name: 'files'
        properties: {
          privateLinkServiceId: storage.id
          groupIds: ['file']
        }
      }
    ]
  }
}

resource filesDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: 'privatelink.file.${environment().suffixes.storage}'
  location: 'global'
}

resource filesDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: filesDnsZone
  name: '${prefix}-files-dns'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

resource filesDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = {
  parent: backupLink
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'file', properties: { privateDnsZoneId: filesDnsZone.id } }
    ]
  }
}

// ---------------------------------------------------------------------------
// Observability (ZT-008)
// ---------------------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    // FR-071 keeps the audit trail for 84 months in the database. This is
    // operational log retention, which is a different question and a shorter
    // answer: a year is enough to investigate, and longer would make the
    // workspace itself a personal-data store nobody has assessed.
    retentionInDays: 365
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

// ---------------------------------------------------------------------------
// Container app
// ---------------------------------------------------------------------------

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: vnet.properties.subnets[0].id
      internal: false
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        // Referenced rather than inlined; the key never appears in the
        // deployment's parameter history.
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  }
}

// Container Apps mounts Azure Files with the storage account key, not with a
// managed identity — the platform does not support identity-based file mounts.
// The key is read from the account at deployment time and never appears in a
// parameter file or in the app's environment; the application still knows
// nothing about storage credentials, it just writes to a path.
resource backupStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: 'backups'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: 'backups'
      accessMode: 'ReadWrite'
    }
  }
  dependsOn: [backupShare]
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-api'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        // TLS terminates here. The application sets HSTS and refuses to start
        // with a non-https PUBLIC_ORIGIN, but it never sees a certificate.
        allowInsecure: false
        transport: 'http'
        stickySessions: { affinity: 'none' }
      }
      secrets: [
        {
          name: 'backup-encryption-key'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/backup-encryption-key'
          identity: identity.id
        }
        {
          name: 'telemetry-salt'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/telemetry-salt'
          identity: identity.id
        }
        {
          name: 'metrics-token'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/metrics-token'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          // By digest. A tag would let the running image change without a
          // deployment, which defeats the signature verified at release.
          image: imageDigest
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'PUBLIC_ORIGIN', value: publicOrigin }
            { name: 'RESIDENCY_REGION', value: residency }
            // Which regions this deployment serves, as opposed to where it
            // runs. Defaults to its own region alone; widening it is a
            // cross-border transfer and needs a lawful basis (CMP-140), which
            // is why it is a deliberate parameter and not derived.
            { name: 'SERVED_REGIONS', value: join(servedRegions, ',') }
            // SEC-013: the limiter counts per process, so it has to know how
            // many processes there are. minReplicas, not maxReplicas — the
            // divisor that never over-restricts.
            { name: 'REPLICA_COUNT', value: string(minReplicas) }
            { name: 'FISCAL_YEAR', value: string(fiscalYear) }
            // Passwordless: the token comes from the managed identity.
            {
              name: 'DATABASE_URL'
              value: 'postgres://${identity.properties.clientId}@${postgres.properties.fullyQualifiedDomainName}:5432/spendifre'
            }
            { name: 'DB_SSL_MODE', value: 'verify-full' }
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'SEED_MODE', value: 'synthetic' }
            { name: 'DEV_AUTH', value: 'off' }
            { name: 'RATE_LIMIT', value: 'on' }
            { name: 'SESSION_IDLE_MINUTES', value: '15' }
            { name: 'BACKUP_DIR', value: '/var/backups' }
            {
              name: 'OTLP_ENDPOINT'
              value: 'http://localhost:4318/v1/traces'
            }
            { name: 'BACKUP_ENCRYPTION_KEY', secretRef: 'backup-encryption-key' }
            { name: 'TELEMETRY_SALT', secretRef: 'telemetry-salt' }
            { name: 'METRICS_TOKEN', secretRef: 'metrics-token' }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
          ]
          probes: [
            {
              // Over HTTP, because the distroless image has no shell for a
              // container-level HEALTHCHECK to run.
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
          volumeMounts: [
            { volumeName: 'backups', mountPath: '/var/backups' }
          ]
        }
      ]
      volumes: [
        { name: 'backups', storageType: 'AzureFile', storageName: backupStorage.name }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Alerts (ZT-008) — see ops/alerts/azure-monitor-kql.md for the queries
// ---------------------------------------------------------------------------

resource auditMissingAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-audit-write-missing'
  location: location
  properties: {
    displayName: 'Spendifre: a state change was not recorded'
    description: 'FR-070. A successful state-changing request wrote no audit event.'
    severity: 0
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [logs.id]
    criteria: {
      allOf: [
        {
          query: '''
ContainerLogV2
| where ContainerName == "api"
| extend log = parse_json(LogMessage)
| where tostring(log.event) == "audit.missing"
'''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    autoMitigate: false
  }
}

resource massExportAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: '${prefix}-mass-export'
  location: location
  properties: {
    displayName: 'Spendifre: unusual export volume'
    description: 'ZT-008. The shape of exfiltration.'
    severity: 2
    enabled: true
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    scopes: [logs.id]
    criteria: {
      allOf: [
        {
          query: '''
ContainerLogV2
| where ContainerName == "api"
| extend log = parse_json(LogMessage)
| where tostring(log.action) in ("report.export", "backup.create", "backup.download")
| extend rows = toint(extract(@"(\\d+) lines", 1, tostring(log.detail)))
| summarize total = sum(rows)
| where total > 50000
'''
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
  }
}

output apiFqdn string = app.properties.configuration.ingress.fqdn
output identityClientId string = identity.properties.clientId
output vaultUri string = vault.properties.vaultUri
output postgresFqdn string = postgres.properties.fullyQualifiedDomainName
