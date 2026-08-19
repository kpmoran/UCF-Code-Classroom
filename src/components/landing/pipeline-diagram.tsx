/**
 * The pipeline, as a diagram: Canvas roster in, graded work back out.
 *
 * Animated with CSS rather than SMIL or JavaScript, so it runs in a server component
 * with nothing to hydrate — and so `prefers-reduced-motion` can switch it off in one
 * place (see globals.css). The motion is a flow along the connectors, which is the
 * thing being explained; nothing here moves for decoration.
 *
 * Colours come from the design tokens, so it follows the theme rather than needing a
 * second copy for dark mode.
 *
 * Marked `role="img"` with a description, because to a screen reader an SVG full of
 * paths is noise. The same four steps are also written out as text beneath it, so the
 * diagram is reinforcement rather than the only way to get the information.
 */
export function PipelineDiagram() {
  const nodes = [
    { x: 60, label: 'Canvas roster', sub: 'CSV export' },
    { x: 235, label: 'Classroom', sub: 'your GitHub org' },
    { x: 410, label: 'Student repos', sub: 'from a template' },
    { x: 585, label: 'Grades', sub: 'back to Canvas' },
  ]

  return (
    <svg
      viewBox="0 0 660 150"
      className="w-full h-auto max-w-3xl"
      role="img"
      aria-label="Four stages: a Canvas roster export becomes a classroom in your GitHub organization, which generates one repository per student from a template, whose autograded results export back to Canvas."
    >
      {/* Connectors, drawn first so the nodes sit on top of them. */}
      {nodes.slice(0, -1).map((n, i) => (
        <line
          key={`c-${i}`}
          x1={n.x + 42}
          y1={62}
          x2={nodes[i + 1].x - 42}
          y2={62}
          className="uccc-flow"
          stroke="var(--border-strong)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="6 8"
          style={{ animationDelay: `${i * 0.4}s` }}
        />
      ))}

      {nodes.map((n, i) => (
        <g key={n.label}>
          <circle
            cx={n.x}
            cy={62}
            r="30"
            fill="var(--surface)"
            stroke={i === 0 || i === 3 ? 'var(--border-strong)' : 'var(--accent)'}
            strokeWidth="2"
          />
          {/* A small mark inside each node, distinct per stage. */}
          {i === 0 ? (
            <g stroke="var(--muted)" strokeWidth="2" strokeLinecap="round">
              <line x1={n.x - 9} y1={54} x2={n.x + 9} y2={54} />
              <line x1={n.x - 9} y1={62} x2={n.x + 9} y2={62} />
              <line x1={n.x - 9} y1={70} x2={n.x + 2} y2={70} />
            </g>
          ) : i === 1 ? (
            <path
              d={`M${n.x - 10} ${68} v-10 a10 10 0 0 1 20 0 v10 z`}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          ) : i === 2 ? (
            <g fill="var(--accent)">
              <rect x={n.x - 12} y={52} width="10" height="8" rx="2" />
              <rect x={n.x + 2} y={52} width="10" height="8" rx="2" />
              <rect x={n.x - 12} y={64} width="10" height="8" rx="2" />
              <rect x={n.x + 2} y={64} width="10" height="8" rx="2" />
            </g>
          ) : (
            <path
              d={`M${n.x - 10} ${62} l6 7 l14 -14`}
              fill="none"
              stroke="var(--success)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          <text
            x={n.x}
            y={112}
            textAnchor="middle"
            fill="var(--foreground)"
            fontSize="13"
            fontWeight="600"
          >
            {n.label}
          </text>
          <text x={n.x} y={130} textAnchor="middle" fill="var(--muted)" fontSize="11">
            {n.sub}
          </text>
        </g>
      ))}
    </svg>
  )
}
