import { Ticks } from "~/components/marketing/guides"

/** The gutter ticks of the About hero. */
export function HeroTicks() {
  return (
    <>
      <Ticks
        side="l"
        ticks={[
          { top: 150 },
          { top: 236, left: "38%" },
          { top: 330 },
          { top: 418, left: "22%" },
          { top: 520 },
          { top: 612, left: "46%" },
          { top: 700 },
        ]}
      />
      <Ticks
        side="r"
        ticks={[
          { top: 120 },
          { top: 210, right: "30%" },
          { top: 300 },
          { top: 470, right: "50%" },
          { top: 560 },
          { top: 668, right: "18%" },
        ]}
      />
    </>
  )
}
