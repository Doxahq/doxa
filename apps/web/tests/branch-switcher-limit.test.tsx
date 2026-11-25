// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import type { NamedDocsBranch } from "@doxahq/contracts/docs-branches"

import { BranchSwitcher } from "~/components/dashboard/content/branches/branch-switcher"
import { showBillingDenial, useBillingDenial } from "~/lib/dashboard/billing-denials"

beforeAll(() => {
  // The command menu measures its list.
  Element.prototype.scrollIntoView ??= () => undefined
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  showBillingDenial(null)
})

function named(id: string, name: string): NamedDocsBranch {
  return { kind: "named", id, name, changeCount: 0, updatedAt: "2026-11-24T00:00:00.000Z" } as unknown as NamedDocsBranch
}

function DenialProbe() {
  const denial = useBillingDenial()
  return <output data-testid="denial">{denial?.kind === "plan_limit" ? denial.details.key : ""}</output>
}

function renderSwitcher(maxBranches: number) {
  const onCreate = vi.fn()
  render(
    <>
      <BranchSwitcher
        projectId="p1"
        branch="main"
        branches={[named("b1", "one"), named("b2", "two")]}
        status={null}
        mainChangeCount={0}
        maxBranches={maxBranches}
        onSelect={async () => undefined}
        onCreate={onCreate}
        onBranchErased={() => undefined}
        onHistory={() => undefined}
        onCompare={() => undefined}
        onMerge={() => undefined}
      />
      <DenialProbe />
    </>,
  )
  return onCreate
}

async function chooseNewBranch() {
  await userEvent.click(screen.getByRole("button", { name: /Switch branch/ }))
  await userEvent.click(await screen.findByText("New branch…"))
  // The menu runs the action on the next frame, after the popover closes.
  await new Promise((resolve) => requestAnimationFrame(resolve))
}

describe("the branch limit in the branch menu", () => {
  test("at the limit, New branch opens the plan limit flow, not the create dialog", async () => {
    const onCreate = renderSwitcher(2)
    await chooseNewBranch()
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByTestId("denial").textContent).toBe("docs.branches_per_site")
  })

  test("under the limit, New branch opens the create dialog", async () => {
    const onCreate = renderSwitcher(3)
    await chooseNewBranch()
    expect(onCreate).toHaveBeenCalledWith("")
    expect(screen.getByTestId("denial").textContent).toBe("")
  })
})
