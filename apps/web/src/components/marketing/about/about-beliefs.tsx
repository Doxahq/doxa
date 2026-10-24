const BELIEFS = [
  {
    title: "Docs are code",
    text: "Pages live on branches, get a preview and go through review, like the code they describe.",
  },
  {
    title: "Agents write, people decide",
    text: "The agent does the busywork. Nothing goes live until a person approves it.",
  },
  {
    title: "Open by default",
    text: "Open source, self-hostable and exportable in one click. You can always take your docs and go.",
  },
  {
    title: "Small and sharp",
    text: "We ship a few things that work well before we ship many that half work.",
  },
]

export function AboutBeliefs() {
  return (
    <section className="col" aria-label="What we believe">
      <div className="ab-beliefs">
        {BELIEFS.map((belief, i) => (
          <div className="ab-belief" key={belief.title}>
            <span className="ab-belief__n">{String(i + 1).padStart(2, "0")}</span>
            <h3>{belief.title}</h3>
            <p>{belief.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
