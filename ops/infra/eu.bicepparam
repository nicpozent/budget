// EU deployment. One of these per residency region — they differ in `residency`
// and `location` and in nothing else, which is what keeps CMP-140 a hosting
// decision rather than a code change.
using './main.bicep'

param residency = 'eu'
param location = 'swedencentral'
param publicOrigin = 'https://spendifre.birgma.com'

// Set by the release pipeline from the signed image it just verified. A tag
// here would let the running image change without a deployment.
param imageDigest = 'ghcr.io/nicpozent/spendifre@sha256:REPLACED_BY_PIPELINE'

param entraTenantId = '00000000-0000-0000-0000-000000000000'
param entraClientId = '00000000-0000-0000-0000-000000000000'
param fiscalYear = 2026
