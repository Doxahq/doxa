// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { useFileDropZone } from "~/lib/dashboard/use-file-drop-zone"

afterEach(cleanup)

function Zone({ onFile, disabled = false }: { onFile: (file: File) => void; disabled?: boolean }) {
  const drop = useFileDropZone({ onFile, disabled })
  return (
    <div>
      <div data-testid="zone" {...drop.zoneProps}>
        <span data-testid="child">child</span>
      </div>
      <output data-testid="state">
        {drop.isOver ? "over" : drop.isDragActive ? "active" : "idle"}
      </output>
    </div>
  )
}

function fileTransfer(files: File[] = [new File(["x"], "logo.png", { type: "image/png" })]) {
  return { dataTransfer: { types: ["Files"], files, dropEffect: "none" } }
}

const state = () => screen.getByTestId("state").textContent

describe("useFileDropZone", () => {
  test("a file dragged over the page marks every zone as ready", () => {
    render(<Zone onFile={vi.fn()} />)
    fireEvent.dragEnter(document.body, fileTransfer())
    expect(state()).toBe("active")
    fireEvent.dragLeave(document.body, fileTransfer())
    expect(state()).toBe("idle")
  })

  test("the zone stays highlighted while the drag moves over its children", () => {
    render(<Zone onFile={vi.fn()} />)
    const zone = screen.getByTestId("zone")
    // The drag enters the page first, so it stays on the page at the end.
    fireEvent.dragEnter(document.body, fileTransfer())
    fireEvent.dragEnter(zone, fileTransfer())
    fireEvent.dragEnter(screen.getByTestId("child"), fileTransfer())
    fireEvent.dragLeave(zone, fileTransfer())
    expect(state()).toBe("over")
    fireEvent.dragLeave(screen.getByTestId("child"), fileTransfer())
    expect(state()).toBe("active")
  })

  test("a drop on the zone passes the first file and clears the highlight", () => {
    const onFile = vi.fn()
    render(<Zone onFile={onFile} />)
    const zone = screen.getByTestId("zone")
    const file = new File(["x"], "logo.svg", { type: "image/svg+xml" })
    fireEvent.dragEnter(zone, fileTransfer([file]))
    fireEvent.drop(zone, fileTransfer([file]))
    expect(onFile).toHaveBeenCalledWith(file)
    expect(state()).toBe("idle")
  })

  test("a disabled zone ignores a drop", () => {
    const onFile = vi.fn()
    render(<Zone onFile={onFile} disabled />)
    const zone = screen.getByTestId("zone")
    fireEvent.dragEnter(zone, fileTransfer())
    expect(state()).toBe("idle")
    fireEvent.drop(zone, fileTransfer())
    expect(onFile).not.toHaveBeenCalled()
  })

  test("a drag of text, not files, changes nothing", () => {
    const onFile = vi.fn()
    render(<Zone onFile={onFile} />)
    const zone = screen.getByTestId("zone")
    const text = { dataTransfer: { types: ["text/plain"], files: [] } }
    fireEvent.dragEnter(zone, text)
    expect(state()).toBe("idle")
    fireEvent.drop(zone, text)
    expect(onFile).not.toHaveBeenCalled()
  })

  test("a file dropped outside a zone does not open in the tab", () => {
    render(<Zone onFile={vi.fn()} />)
    const outside = fireEvent.drop(document.body, fileTransfer())
    // fireEvent returns false when a listener called preventDefault.
    expect(outside).toBe(false)
  })
})
