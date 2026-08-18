import { requireStaff } from '@/lib/auth/dal'
import { buildClassroomGradeExport } from '@/lib/canvas/gradeData'
import { gradeCsvFilename } from '@/lib/canvas/exportGrades'

export const runtime = 'nodejs'

/**
 * Download the Canvas grade import CSV.
 *
 * A route handler rather than a server action because the result is a file: an
 * action would have to ship the whole CSV to the client as a string and rebuild a
 * Blob, which loses the filename and the browser's own download handling.
 *
 * Staff-only, and `requireStaff` runs before anything is read — the URL is
 * guessable from the classroom slug.
 */
export async function GET(
  request: Request,
  context: RouteContext<'/classrooms/[slug]/grades/export'>,
): Promise<Response> {
  const { slug } = await context.params
  const { classroom } = await requireStaff(slug)

  const url = new URL(request.url)
  const assignmentIds = url.searchParams.getAll('assignment').filter(Boolean)
  const includePointsPossible = url.searchParams.get('points') === '1'

  const result = await buildClassroomGradeExport(classroom.id, {
    assignmentIds: assignmentIds.length > 0 ? assignmentIds : undefined,
    includePointsPossible,
  })

  const filename = gradeCsvFilename(classroom.slug, new Date())

  return new Response(result.csv, {
    headers: {
      // `text/csv` with an explicit UTF-8 charset: names carry accents and
      // non-Latin scripts, and a missing charset makes Excel mangle them.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // A grade export must never be served from a cache — it changes as soon as
      // any score does.
      'Cache-Control': 'no-store',
    },
  })
}
