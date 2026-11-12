import { DNS_HOST_PROVIDERS } from "@doxahq/contracts"
import { describe, expect, test } from "vitest"

import { DNS_HOST_BRANDS } from "~/lib/dashboard/dns-host-brands"
import {
  DNS_SETUP_GUIDE_IDS,
  buildDnsSetupGuide,
  getDnsRecordNameValue,
  getDnsSetupGuideLabel,
  getRelativeRecordName,
  isDnsSetupGuideId,
  resolveDnsSetupGuideId,
  type DnsSetupGuide,
} from "~/lib/dashboard/dns-setup-guides"

describe("dns setup guides", () => {
  test.each(DNS_HOST_PROVIDERS)("%s has a name, a help page and the short steps", (provider) => {
    const guide = buildDnsSetupGuide(provider, "example.com")
    expect(guide.id).toBe(provider)
    expect(guide.hostName).toBe(getDnsSetupGuideLabel(provider))
    expect(guide.helpUrl).toMatch(/^https:\/\//)
    expect(stepText(guide, "open")).toContain("Open the DNS records for example.com in ")
    expect(guide.steps.some((step) => step.kind === "record")).toBe(true)
    expect(stepText(guide, "save")).toBe("Save it, then click Check again. DNS changes can take a few minutes.")
  })

  test.each(DNS_HOST_PROVIDERS)("%s has a brand mark", (provider) => {
    const brand = DNS_HOST_BRANDS[provider]
    expect(brand.path).toMatch(/^M[\d.-]/)
    expect(brand.color === null || /^#[0-9A-F]{6}$/.test(brand.color)).toBe(true)
  })

  test("steps come in order: open, record, proxy note when needed, save", () => {
    expect(stepIds(buildDnsSetupGuide("cloudflare", "example.com"))).toEqual(["open", "record", "proxy", "save"])
    expect(stepIds(buildDnsSetupGuide("other", "example.com"))).toEqual(["open", "record", "proxy", "save"])
    for (const provider of DNS_HOST_PROVIDERS.filter((id) => id !== "cloudflare")) {
      expect(stepIds(buildDnsSetupGuide(provider, "example.com"))).toEqual(["open", "record", "save"])
    }
  })

  test("Cloudflare asks for DNS only, the generic guide for no proxy", () => {
    expect(stepText(buildDnsSetupGuide("cloudflare", "example.com"), "proxy")).toBe("Set the proxy status to DNS only (grey cloud).")
    expect(stepText(buildDnsSetupGuide("other", "example.com"), "proxy")).toBe("If your DNS host offers a proxy or CDN for the record, turn it off.")
  })

  test("the generic guide names no host and has no help link", () => {
    const guide = buildDnsSetupGuide("other", "example.com")
    expect(guide.hostName).toBeNull()
    expect(guide.helpUrl).toBeNull()
    expect(stepText(guide, "open")).toBe("Open the DNS records for example.com where you manage your domain.")
  })

  test("without a zone it says 'your domain'", () => {
    expect(stepText(buildDnsSetupGuide("namecheap", null), "open"))
      .toBe("Open the DNS records for your domain in your Namecheap account (Advanced DNS).")
  })
})

describe("record name value", () => {
  test.each([
    ["docs.example.com", "example.com", "docs"],
    ["a.b.example.co.uk", "example.co.uk", "a.b"],
    ["Docs.Example.com.", "example.com", "docs"],
    ["example.com", "example.com", "@"],
    ["Docs.Example.com", null, "docs.example.com"],
    ["docs.other.com", "example.com", "docs.other.com"],
  ])("%s in zone %s is %s", (hostname, zone, expected) => {
    expect(getDnsRecordNameValue(hostname, zone)).toBe(expected)
  })

  test.each([
    ["example.com", "example.com"],
    ["docs.example.com", "other.com"],
    ["docs.notexample.com", "example.com"],
    ["docs.example.com", null],
  ])("%s in %s has no relative name", (hostname, zone) => {
    expect(getRelativeRecordName(hostname, zone)).toBeNull()
  })
})

describe("guide ids", () => {
  test("lists every provider and then the generic guide", () => {
    expect(DNS_SETUP_GUIDE_IDS).toEqual([...DNS_HOST_PROVIDERS, "other"])
    expect(getDnsSetupGuideLabel("other")).toBe("Other DNS host")
    expect(getDnsSetupGuideLabel("route53")).toBe("Amazon Route 53")
  })

  test("accepts only known ids", () => {
    expect(isDnsSetupGuideId("cloudflare")).toBe(true)
    expect(isDnsSetupGuideId("other")).toBe(true)
    expect(isDnsSetupGuideId("Cloudflare")).toBe(false)
    expect(isDnsSetupGuideId("")).toBe(false)
  })

  test("the user's pick wins, then the detected host, then the generic guide", () => {
    expect(resolveDnsSetupGuideId("godaddy", "cloudflare")).toBe("godaddy")
    expect(resolveDnsSetupGuideId("other", "cloudflare")).toBe("other")
    expect(resolveDnsSetupGuideId(null, "cloudflare")).toBe("cloudflare")
    expect(resolveDnsSetupGuideId(null, null)).toBe("other")
  })
})

function stepIds(guide: DnsSetupGuide): string[] {
  return guide.steps.map((step) => step.id)
}

function stepText(guide: DnsSetupGuide, id: string): string {
  const step = guide.steps.find((candidate) => candidate.id === id)
  if (!step || step.kind !== "text") throw new Error(`No text step ${id}`)
  return step.parts.map((part) => (typeof part === "string" ? part : part.code)).join("")
}
