// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { PageSlugField, type PageSlugEdit } from "~/components/dashboard/content/write-editor/page-slug-field"

afterEach(cleanup)

function renderField(edit: PageSlugEdit | null, disabled = false) {
  render(<PageSlugField href="/api/auth" edit={edit} disabled={disabled} />)
}

function slugEdit(onRename: PageSlugEdit["onRename"] = vi.fn(async () => undefined)): PageSlugEdit {
  return { prefix: "api", slug: "auth", onRename }
}

function openInput(): HTMLInputElement {
  fireEvent.click(screen.getByRole("button", { name: "Edit page slug" }))
  return screen.getByRole("textbox", { name: "Page slug" }) as HTMLInputElement
}

describe("the page slug field", () => {
  test("shows the slug and an edit button", () => {
    renderField(slugEdit())
    expect(screen.getByText("/api/auth")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Edit page slug" })).toBeTruthy()
  })

  test("a page whose URL cannot change has no edit button", () => {
    renderField(null)
    expect(screen.queryByRole("button", { name: "Edit page slug" })).toBeNull()
  })

  test("the edit button is disabled while the editor is read only", () => {
    renderField(slugEdit(), true)
    expect(screen.getByRole("button", { name: "Edit page slug" })).toHaveProperty("disabled", true)
  })

  test("the input shows the section prefix and the slug", () => {
    renderField(slugEdit())
    const input = openInput()
    expect(input.value).toBe("auth")
    expect(screen.getByText("/api/")).toBeTruthy()
  })

  test("Enter renames the page", async () => {
    const onRename = vi.fn(async () => undefined)
    renderField(slugEdit(onRename))
    const input = openInput()
    fireEvent.change(input, { target: { value: " tokens " } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith("tokens")
  })

  test("leaving the input renames the page", async () => {
    const onRename = vi.fn(async () => undefined)
    renderField(slugEdit(onRename))
    const input = openInput()
    fireEvent.change(input, { target: { value: "tokens" } })
    await act(async () => {
      fireEvent.blur(input)
    })
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(onRename).toHaveBeenCalledWith("tokens")
  })

  test("Escape cancels without a rename", () => {
    const onRename = vi.fn(async () => undefined)
    renderField(slugEdit(onRename))
    const input = openInput()
    fireEvent.change(input, { target: { value: "tokens" } })
    fireEvent.keyDown(input, { key: "Escape" })
    fireEvent.blur(input)
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.getByText("/api/auth")).toBeTruthy()
  })

  test("an unchanged slug closes without a rename", async () => {
    const onRename = vi.fn(async () => undefined)
    renderField(slugEdit(onRename))
    const input = openInput()
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  test("an invalid slug shows the rule and keeps the input open", async () => {
    const onRename = vi.fn(async () => undefined)
    renderField(slugEdit(onRename))
    const input = openInput()
    fireEvent.change(input, { target: { value: "Bad Slug" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(onRename).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toMatch(/lowercase letters/)
    expect(input.getAttribute("aria-invalid")).toBe("true")
  })

  test("a double click on the slug opens the input with focus", () => {
    renderField(slugEdit())
    fireEvent.doubleClick(screen.getByText("/api/auth"))
    const input = screen.getByRole("textbox", { name: "Page slug" })
    expect(document.activeElement).toBe(input)
  })

  test("a double click does nothing while the editor is read only", () => {
    renderField(slugEdit(), true)
    fireEvent.doubleClick(screen.getByText("/api/auth"))
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  test("a page whose URL cannot change ignores a double click", () => {
    renderField(null)
    fireEvent.doubleClick(screen.getByText("/api/auth"))
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  test("while the rename runs, the input shows a spinner and ignores Enter, Escape and blur", async () => {
    let finish: () => void = () => undefined
    const onRename = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    renderField(slugEdit(onRename))
    const input = openInput()
    fireEvent.change(input, { target: { value: "tokens" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(input.getAttribute("aria-busy")).toBe("true")
    expect(input.readOnly).toBe(true)

    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Escape" })
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("textbox", { name: "Page slug" })).toBe(input)

    await act(async () => finish())
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  test("a failed rename from Enter returns focus to the input", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("A page already uses this URL.")
    })
    renderField(slugEdit(onRename))
    const input = openInput()
    fireEvent.change(input, { target: { value: "tokens" } })
    input.blur()
    input.focus()
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Page slug" }))
    expect(input.readOnly).toBe(false)
  })

  test("a refused rename shows the server message and keeps the input open", async () => {
    const onRename = vi.fn(async () => {
      throw new Error("A page already uses this URL.")
    })
    renderField(slugEdit(onRename))
    const input = openInput()
    fireEvent.change(input, { target: { value: "tokens" } })
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(screen.getByRole("alert").textContent).toBe("A page already uses this URL.")
    expect(screen.getByRole("textbox", { name: "Page slug" })).toBeTruthy()
  })

  test("the default page leads with / and an INDEX tag, and keeps its own slug", () => {
    render(<PageSlugField href="/api/auth" edit={slugEdit()} isIndex disabled={false} />)
    expect(screen.getByText("/")).toBeTruthy()
    expect(screen.getByText("Index")).toBeTruthy()
    expect(screen.getByText("· /api/auth")).toBeTruthy()
  })

  test("the pencil on the default page edits its own slug and says where the page is served", () => {
    render(<PageSlugField href="/api/auth" edit={slugEdit()} isIndex disabled={false} />)
    expect(openInput().value).toBe("auth")
    expect(screen.getByText("Served at / while this is the default page.")).toBeTruthy()
  })

  test("a page at the root path shows / once", () => {
    render(<PageSlugField href="/" edit={null} isIndex disabled={false} />)
    expect(screen.getAllByText(/\//)).toHaveLength(1)
    expect(screen.getByText("Index")).toBeTruthy()
  })
})
