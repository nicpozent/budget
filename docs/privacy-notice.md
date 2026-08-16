# Privacy notice — Spendifre (draft for the organisation)

GDPR Articles 13 and 14. This closes open action 1 in
[`dpia-personnel-data.md`](./dpia-personnel-data.md) §5.

> **Status: drafted, not issued.** This is written to be given to employees who
> use Spendifre, but a privacy notice is a statement by the controller and only
> the controller can make it. Legal and the DPO should review it; the
> organisation must fill in every **[org]** placeholder before it is issued.
> Nothing here should be published while a placeholder remains.

The notice is deliberately written in plain language rather than in the register
of the rest of these documents. Its readers are colleagues who want to know what
the system records about them, not architects.

---

## About this notice

Spendifre is the system Birgma and Biltema Group IT use to prepare the annual IT
budget. If you fill in budget lines, approve them, or administer the system, it
holds information about you. This notice explains what, why, and for how long.

**Who is responsible:** **[org]** *controller name and registered address.*

**Who to contact:** **[org]** *DPO name and email.*

## What we hold about you

**Your identity.** Your name, work email address, and the identifier your
Microsoft work account uses. These come from Entra ID; you do not type them in.

**Your role and what you can see.** Which Spendifre role your Entra group
membership gives you, and which entities' budgets you own.

**What you did.** Every change you make is recorded: what you changed, when,
which entity it belonged to, and any comment or justification you wrote. This
record cannot be edited or deleted, by you or by an administrator — that is
deliberate, and the next section explains why.

**How you signed in.** The time you authenticated, the method (for example
whether you used a security key), and whether your device was recognised as
managed. We also store a one-way scrambled form of your IP address and browser
identification. That scrambling is not reversible: it lets us tell whether two
actions came from the same session without keeping an address that identifies
where you were.

**Anything you type.** Line names, justifications and comments are free text. If
you write a colleague's name in one, the system holds that too. Please avoid
naming individuals in budget lines — describe the role or the activity instead.

## Why we hold it

**To run the budget process.** The system cannot show you your entity's lines
without knowing which entity is yours.

**For financial control.** A budget that determines real spend needs to show who
proposed a figure and who approved it. That is the purpose of the permanent
record.

**To investigate security incidents.** If an account is misused, the record is
how we establish what happened.

**We do not use it to assess your performance.** The record of who changed what
exists for financial control and incident investigation. Using it to evaluate
how you work would be a different purpose, and we have committed not to — see
[`lawful-basis.md`](./lawful-basis.md), which records that limit formally.

## Our legal basis

**[org]** *to be confirmed — see [`lawful-basis.md`](./lawful-basis.md) for the
assessment. The expected answer is legitimate interests (Article 6(1)(f)) for
the audit trail, and legal obligation (Article 6(1)(c)) for the parts of the
record that support statutory bookkeeping.*

We do not rely on your consent, because you are not in a position to refuse and
still do your job — which is exactly why consent would not be valid here.

## Who sees it

- Your own entity's budget owner and the people who approve it.
- Group IT Finance and the CFO, who see across entities.
- Administrators, for support and governance.

Nobody outside the group sees it. The system sends nothing to any third party.

Your record of activity is visible to you: the **Audit trail** view shows your
own events. Administrators and the CFO can see everyone's.

## Where it is held

Inside the region your entity belongs to. An entity in the EU is served from the
EU; the system refuses to return an entity's data from outside its region, even
to an administrator.

**[org]** *If you work for a Chinese group entity, this section needs a specific
answer that has not yet been decided. See `CMP-140`.*

## How long we keep it

| What | How long |
| --- | --- |
| Budget figures | 10 years |
| The permanent record of changes | 7 years |
| Comments and justifications | 3 years |
| Your account, after you stop using the system | 2 years, then your name and email are replaced |

When your account is removed, the record of what you did is not deleted — it is
disconnected from your name. The entries stay so the budget history remains
complete, but they stop identifying you.

## Your rights

You can ask to:

- **See what we hold.** An administrator can produce a complete export of your
  data.
- **Correct it.** Your name and email come from Entra ID, so a correction there
  flows through.
- **Have it erased.** We will pseudonymise your record rather than delete it, for
  the reason above; if that is not acceptable to you, contact the DPO.
- **Object** to the processing based on legitimate interests.
- **Complain** to your supervisory authority. In Sweden that is
  Integritetsskyddsmyndigheten (IMY), imy@imy.se.

To exercise any of these, contact **[org]** *DPO email*.

## Changes to this notice

**[org]** *Record the date of issue and how changes will be communicated.*
