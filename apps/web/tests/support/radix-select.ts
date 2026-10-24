import { fireEvent, screen } from "@testing-library/react"

/**
 * jsdom lacks the pointer-capture and scroll APIs that the Radix select
 * calls when it opens. Call this once in a test file that opens a select.
 */
export function installRadixSelectPolyfills(): void {
  const prototype = window.HTMLElement.prototype
  prototype.hasPointerCapture ??= () => false
  prototype.releasePointerCapture ??= () => undefined
  prototype.scrollIntoView ??= () => undefined
}

/** Opens the select with this accessible name and picks the option with this label. */
export async function pickSelectOption(selectName: string, optionLabel: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole("combobox", { name: selectName }), { key: "Enter" })
  fireEvent.click(await screen.findByRole("option", { name: optionLabel }))
}

/** Opens the select with this accessible name and returns the labels of its options. */
export async function readSelectOptions(selectName: string): Promise<string[]> {
  fireEvent.keyDown(screen.getByRole("combobox", { name: selectName }), { key: "Enter" })
  await screen.findAllByRole("option")
  const labels = screen.getAllByRole("option").map((option) => option.textContent ?? "")
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" })
  return labels
}

/** The label that the closed select shows. */
export function selectedLabel(selectName: string): string {
  return screen.getByRole("combobox", { name: selectName }).textContent ?? ""
}
