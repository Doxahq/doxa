const PLAY_PATH = "M0 0 9 5 0 10Z"
const PAUSE_PATH = "M0 0H3V10H0ZM6 0H9V10H6Z"

/** The Pause and Play button of the art on a marketing page. */
export function ArtToggle({ playing, onToggle, className }: { playing: boolean; onToggle: () => void; className?: string }) {
  return (
    <button type="button" className={`btn btn--line btn--sm${className ? ` ${className}` : ""}`} onClick={onToggle}>
      <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true">
        <path fill="currentColor" d={playing ? PAUSE_PATH : PLAY_PATH} />
      </svg>
      {playing ? "Pause" : "Play"}
    </button>
  )
}
