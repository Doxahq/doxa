// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DocsDomainDnsHost, DocsDomainDnsRecord } from "@doxahq/contracts"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { DnsSetupGuide } from "~/components/dashboard/dns-setup-guide"
import { readDnsHostChoice, writeDnsHostChoice } from "~/lib/dashboard/dns-host-choice"
import { stubMemoryLocalStorage } from "./support/memory-storage"
import { installRadixSelectPolyfills, pickSelectOption, readSelectOptions, selectedLabel } from "./support/radix-select"

const mocks = vi.hoisted(() => ({ getDocsDomainDnsHost: vi.fn() }))

vi.mock("~/lib/platform-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/platform-api")>()),
  getDocsDomainDnsHost: mocks.getDocsDomainDnsHost,
}))

const DOMAIN = { id: "domain-1", projectId: "project-1", hostname: "docs.example.com" }
const RECORD: DocsDomainDnsRecord = {
  type: "CNAME",
  name: "docs.example.com",
  target: "cname.doxa.page",
  proxyStatus: "dns_only",
}
const CLOUDFLARE: DocsDomainDnsHost = {
  provider: "cloudflare",
  zone: "example.com",
  nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
}

installRadixSelectPolyfills()

beforeEach(() => {
  mocks.getDocsDomainDnsHost.mockReset()
  stubMemoryLocalStorage()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("dns setup guide panel", () => {
  test("shows a skeleton while the lookup runs, then the detected host's steps", async () => {
    let resolve: (value: DocsDomainDnsHost) => void = () => {}
    mocks.getDocsDomainDnsHost.mockReturnValue(new Promise<DocsDomainDnsHost>((done) => { resolve = done }))
    renderPanel()

    expect(screen.getByLabelText("Detecting your DNS host").getAttribute("aria-busy")).toBe("true")
    expect(screen.getByRole("status").textContent).toBe("Detecting your DNS host…Reading the nameservers for docs.example.com")
    // The values to copy do not wait for the lookup.
    expect(screen.getByText("docs.example.com")).toBeTruthy()
    expect(screen.getByText("cname.doxa.page")).toBeTruthy()
    resolve(CLOUDFLARE)

    expect(await screen.findByText("Your DNS is on Cloudflare")).toBeTruthy()
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getByText("Detected from your nameservers")).toBeTruthy()
    expect(screen.getByText("Set the proxy status to DNS only (grey cloud).")).toBeTruthy()
    expect(recordValues()).toEqual(["CNAME", "docs", "cname.doxa.page"])
    const help = screen.getByRole<HTMLAnchorElement>("link", { name: /Cloudflare help/ })
    expect(help.href).toContain("developers.cloudflare.com")
    expect(mocks.getDocsDomainDnsHost).toHaveBeenCalledWith("project-1", "domain-1")
  })

  test("'Not using Cloudflare?' switches to the generic steps and remembers it", async () => {
    mocks.getDocsDomainDnsHost.mockResolvedValue(CLOUDFLARE)
    renderPanel()

    await userEvent.click(await screen.findByRole("button", { name: "Not using Cloudflare?" }))

    expect(screen.queryByText(/Your DNS is on/)).toBeNull()
    expect(screen.getByRole("combobox", { name: "DNS host" }).textContent).toBe("Other DNS host")
    expect(screen.getByText(/where you manage your domain/)).toBeTruthy()
    expect(screen.queryByRole("link", { name: /help/ })).toBeNull()
    expect(readDnsHostChoice("domain-1")).toBe("other")
  })

  test("a saved pick wins over the detected host", async () => {
    writeDnsHostChoice("domain-1", "godaddy")
    mocks.getDocsDomainDnsHost.mockResolvedValue(CLOUDFLARE)
    renderPanel()

    const picker = await screen.findByRole("combobox", { name: "DNS host" })
    expect(picker.textContent).toBe("GoDaddy")
    expect(screen.getByText(/in your GoDaddy account/)).toBeTruthy()
    expect(screen.queryByText(/grey cloud/)).toBeNull()
    expect(screen.queryByText(/proxy or CDN/)).toBeNull()
  })

  test("an unknown host shows the picker and the nameservers", async () => {
    mocks.getDocsDomainDnsHost.mockResolvedValue({
      provider: null,
      zone: "example.com",
      nameservers: ["ns1.example-dns.net", "ns2.example-dns.net"],
    })
    renderPanel()

    expect((await screen.findByRole("combobox", { name: "DNS host" })).textContent).toBe("Other DNS host")
    expect(screen.getByText("ns1.example-dns.net, ns2.example-dns.net")).toBeTruthy()
    expect(recordValues()).toEqual(["CNAME", "docs", "cname.doxa.page"])
  })

  test("the picker lists every host and marks the detected one", async () => {
    mocks.getDocsDomainDnsHost.mockResolvedValue(CLOUDFLARE)
    renderPanel()
    await userEvent.click(await screen.findByRole("button", { name: "Not using Cloudflare?" }))

    expect(await readSelectOptions("DNS host")).toEqual([
      "Cloudflare (detected)",
      "Namecheap",
      "GoDaddy",
      "Amazon Route 53",
      "Vercel",
      "Porkbun",
      "DigitalOcean",
      "Other DNS host",
    ])
  })

  test("picking a host shows its steps, and picking the detected host clears the override", async () => {
    mocks.getDocsDomainDnsHost.mockResolvedValue(CLOUDFLARE)
    renderPanel()
    await userEvent.click(await screen.findByRole("button", { name: "Not using Cloudflare?" }))

    await pickSelectOption("DNS host", "Porkbun")
    expect(selectedLabel("DNS host")).toBe("Porkbun")
    expect(screen.getByText(/in your Porkbun account/)).toBeTruthy()
    expect(screen.getByRole("link", { name: /Porkbun help/ })).toBeTruthy()
    expect(readDnsHostChoice("domain-1")).toBe("porkbun")

    await pickSelectOption("DNS host", "Cloudflare (detected)")
    expect(await screen.findByText("Your DNS is on Cloudflare")).toBeTruthy()
    expect(readDnsHostChoice("domain-1")).toBeNull()
  })

  test("a failed lookup falls back to the generic steps", async () => {
    mocks.getDocsDomainDnsHost.mockRejectedValue(new Error("network"))
    renderPanel()

    await waitFor(() => expect(screen.getByRole("combobox", { name: "DNS host" }).textContent).toBe("Other DNS host"))
    expect(screen.getByText(/for your domain where you manage your domain/)).toBeTruthy()
    expect(screen.queryByText(/nameservers/)).toBeNull()
    // Without a zone the full hostname is the safe name to enter.
    expect(recordValues()).toEqual(["CNAME", "docs.example.com", "cname.doxa.page"])
  })

  test("the name and the target each have a copy button that copies the shown value", async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    mocks.getDocsDomainDnsHost.mockResolvedValue(CLOUDFLARE)
    renderPanel()

    // fireEvent, because user-event puts its own clipboard in place of this stub.
    await screen.findByText("Your DNS is on Cloudflare")
    fireEvent.click(screen.getByRole("button", { name: "Copy DNS name" }))
    fireEvent.click(screen.getByRole("button", { name: "Copy DNS target" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText.mock.calls).toEqual([["docs"], ["cname.doxa.page"]])
    // The check mark moved to the last copied value.
    expect(screen.getByRole("button", { name: "DNS target copied" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy DNS name" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Copy Type/i })).toBeNull()
  })
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <DnsSetupGuide domain={DOMAIN} record={RECORD} />
    </QueryClientProvider>,
  )
}

function recordValues(): string[] {
  return Array.from(document.querySelectorAll("dd"), (value) => value.textContent ?? "")
}
