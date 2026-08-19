import { Badge } from '@/components/ui/badge'
import { checkOrgOwnership } from '@/lib/github/operations/orgs'

/**
 * The organization card on the classroom settings page, and its loading state.
 *
 * The role check is a live GitHub call, and it used to run before the page replied
 * — which cost about 200ms and delayed every other thing on the page, including the
 * settings form and the archive controls, none of which depend on it. All it decides
 * is which of two badges to show.
 *
 * So it streams: the page sends the card immediately with the organization name,
 * which the database already knows, and the badge arrives when GitHub answers.
 *
 * Suspense is right here and was wrong for the template picker. The difference is
 * user input: swapping this badge when the data lands costs nothing, whereas
 * re-mounting a text field mid-word discards what was being typed. Same mechanism,
 * opposite conclusion, decided by whether the subtree holds state a person owns.
 */

function OrgRow({ orgLogin, badge }: { orgLogin: string; badge: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <a
        href={`https://github.com/${orgLogin}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono hover:underline"
      >
        {orgLogin}
      </a>
      {badge}
    </div>
  )
}

/** Shown while GitHub is being asked. Says what it is waiting for, not just "…". */
export function OrgOwnershipSkeleton({ orgLogin }: { orgLogin: string }) {
  return (
    <OrgRow
      orgLogin={orgLogin}
      badge={
        <Badge tone="neutral" aria-live="polite">
          Checking your role…
        </Badge>
      }
    />
  )
}

export async function OrgOwnershipPanel({
  installationId,
  orgLogin,
  githubLogin,
}: {
  installationId: bigint
  orgLogin: string
  githubLogin: string | null
}) {
  /*
   * Re-checked live rather than cached: an instructor's org role can change between
   * terms, and a stale "you are an owner" is worse than no answer — it is the claim
   * that group assignments will work.
   */
  let ownership: { isOwner: boolean; reason?: string } = { isOwner: false }
  try {
    ownership = githubLogin
      ? await checkOrgOwnership(installationId, orgLogin, githubLogin)
      : { isOwner: false, reason: 'Your account has no linked GitHub login.' }
  } catch {
    ownership = { isOwner: false, reason: 'Could not reach GitHub to check your role.' }
  }

  return (
    <>
      <OrgRow
        orgLogin={orgLogin}
        badge={
          ownership.isOwner ? (
            <Badge tone="success">You are an organization Owner</Badge>
          ) : (
            <Badge tone="warning">Not confirmed as Owner</Badge>
          )
        }
      />
      {!ownership.isOwner && ownership.reason ? (
        <p className="text-muted">
          {ownership.reason} Individual assignments are unaffected; group assignments create
          GitHub teams, which may require Owner rights.
        </p>
      ) : null}
    </>
  )
}
