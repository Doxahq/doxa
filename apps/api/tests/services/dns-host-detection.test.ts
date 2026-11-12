import { describe, expect, test, vi } from "vitest";
import {
  classifyNameservers,
  DohNameserverResolver,
  listZoneCandidates,
  matchNameserver,
  NameserverDnsHostDetector,
  UNKNOWN_DNS_HOST,
  type NameserverResolver,
} from "../../src/services/dns-host-detection";

describe("matchNameserver", () => {
  test.each([
    ["ada.ns.cloudflare.com", "cloudflare"],
    ["ADA.NS.CLOUDFLARE.COM.", "cloudflare"],
    ["dns1.registrar-servers.com", "namecheap"],
    ["pdns1.registrar-servers.com.", "namecheap"],
    ["ns51.domaincontrol.com", "godaddy"],
    ["ns-421.awsdns-52.com", "route53"],
    ["ns-1707.awsdns-21.co.uk.", "route53"],
    ["ns-520.awsdns-01.net", "route53"],
    ["ns-1283.awsdns-32.org", "route53"],
    ["ns1.vercel-dns.com", "vercel"],
    ["curitiba.ns.porkbun.com", "porkbun"],
    ["ns1.digitalocean.com", "digitalocean"],
  ] as const)("maps %s to %s", (nameserver, provider) => {
    expect(matchNameserver(nameserver)).toBe(provider);
  });

  test.each([
    "dns1.p08.nsone.net",
    "ns1.cloudflare.com",
    "cloudflare.com",
    "ns.cloudflare.com.evil.example",
    "registrar-servers.com.example",
    "ns-1.awsdns-1.io",
    "www.digitalocean.com",
    "ns1.example.com",
  ])("does not map %s", (nameserver) => {
    expect(matchNameserver(nameserver)).toBeNull();
  });
});

describe("classifyNameservers", () => {
  test("returns the provider when every nameserver belongs to it", () => {
    expect(classifyNameservers(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"])).toBe("cloudflare");
  });

  test("returns null for a zone served by two providers", () => {
    expect(classifyNameservers([
      "dns1.p08.nsone.net",
      "ns-421.awsdns-52.com",
    ])).toBeNull();
    expect(classifyNameservers([
      "ada.ns.cloudflare.com",
      "ns-421.awsdns-52.com",
    ])).toBeNull();
  });

  test("returns null for unknown or missing nameservers", () => {
    expect(classifyNameservers(["ns1.example.net", "ns2.example.net"])).toBeNull();
    expect(classifyNameservers([])).toBeNull();
  });
});

describe("listZoneCandidates", () => {
  test("lists every name from the hostname up to the label under the top-level domain", () => {
    expect(listZoneCandidates("docs.example.co.uk")).toEqual([
      "docs.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    expect(listZoneCandidates("Example.com.")).toEqual(["example.com"]);
  });

  test("never lists a bare top-level domain", () => {
    expect(listZoneCandidates("com")).toEqual([]);
    expect(listZoneCandidates("")).toEqual([]);
  });

  test("keeps the least specific candidates of a very long hostname", () => {
    const candidates = listZoneCandidates("a.b.c.d.e.f.g.h.i.j.example.com");
    expect(candidates).toHaveLength(8);
    expect(candidates.at(-1)).toBe("example.com");
    expect(candidates[0]).toBe("d.e.f.g.h.i.j.example.com");
  });
});

describe("DohNameserverResolver", () => {
  test("asks the JSON API for NS records and normalizes the nameservers", async () => {
    const fetcher = createDohFetch({
      Status: 0,
      Answer: [
        { name: "example.com", type: 2, TTL: 300, data: "Ada.NS.Cloudflare.com." },
        { name: "example.com.", type: 2, TTL: 300, data: "bob.ns.cloudflare.com." },
      ],
    });
    const resolver = new DohNameserverResolver({ fetcher });

    await expect(resolver.lookupNameservers("example.com", new AbortController().signal))
      .resolves.toEqual(["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]);

    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://cloudflare-dns.com/dns-query?name=example.com&type=NS");
    expect(init?.headers).toEqual({ accept: "application/dns-json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("ignores records of a CNAME target, because a CNAME owner is not a zone", async () => {
    const resolver = new DohNameserverResolver({
      fetcher: createDohFetch({
        Status: 0,
        Answer: [
          { name: "docs.example.com", type: 5, TTL: 300, data: "cname.doxa.page." },
          { name: "cname.doxa.page", type: 2, TTL: 300, data: "ada.ns.cloudflare.com." },
        ],
      }),
    });

    await expect(resolver.lookupNameservers("docs.example.com", new AbortController().signal))
      .resolves.toEqual([]);
  });

  test("reads a name that does not exist as no zone", async () => {
    const resolver = new DohNameserverResolver({
      fetcher: createDohFetch({
        Status: 3,
        Authority: [{ name: "com", type: 6, TTL: 900, data: "a.gtld-servers.net. nstld.verisign-grs.com." }],
      }),
    });

    await expect(resolver.lookupNameservers("missing.example.com", new AbortController().signal))
      .resolves.toEqual([]);
  });

  test("throws on a server failure instead of reading it as no zone", async () => {
    const resolver = new DohNameserverResolver({ fetcher: createDohFetch({ Status: 2 }) });

    await expect(resolver.lookupNameservers("example.com", new AbortController().signal))
      .rejects.toThrow("DNS status 2");
  });

  test("throws on an HTTP error", async () => {
    const resolver = new DohNameserverResolver({
      fetcher: vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 })),
    });

    await expect(resolver.lookupNameservers("example.com", new AbortController().signal))
      .rejects.toThrow("HTTP 503");
  });

  test("throws on a body that is not a DNS JSON answer", async () => {
    const resolver = new DohNameserverResolver({ fetcher: createDohFetch({ answer: "no" }) });

    await expect(resolver.lookupNameservers("example.com", new AbortController().signal))
      .rejects.toThrow();
  });
});

describe("NameserverDnsHostDetector", () => {
  test("uses the most specific candidate that has nameservers", async () => {
    const resolver = createResolver({
      "docs.example.com": [],
      "example.com": ["bob.ns.cloudflare.com", "ada.ns.cloudflare.com", "ada.ns.cloudflare.com"],
    });
    const detector = new NameserverDnsHostDetector({ resolver });

    await expect(detector.detect("docs.example.com")).resolves.toEqual({
      provider: "cloudflare",
      zone: "example.com",
      nameservers: ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    });
    expect(resolver.lookupNameservers).toHaveBeenCalledTimes(2);
  });

  test("prefers a delegated subdomain over its parent zone", async () => {
    const detector = new NameserverDnsHostDetector({
      resolver: createResolver({
        "docs.example.com": ["ns1.vercel-dns.com", "ns2.vercel-dns.com"],
        "example.com": ["ns51.domaincontrol.com", "ns52.domaincontrol.com"],
      }),
    });

    await expect(detector.detect("docs.example.com")).resolves.toMatchObject({
      provider: "vercel",
      zone: "docs.example.com",
    });
  });

  test("detects the zone of an apex hostname", async () => {
    const detector = new NameserverDnsHostDetector({
      resolver: createResolver({ "example.com": ["dns1.registrar-servers.com", "dns2.registrar-servers.com"] }),
    });

    await expect(detector.detect("example.com")).resolves.toMatchObject({
      provider: "namecheap",
      zone: "example.com",
    });
  });

  test("keeps the zone and nameservers of an unknown DNS host", async () => {
    const detector = new NameserverDnsHostDetector({
      resolver: createResolver({
        "docs.example.com": [],
        "example.com": ["ns1.example-dns.net", "ns2.example-dns.net"],
      }),
    });

    await expect(detector.detect("docs.example.com")).resolves.toEqual({
      provider: null,
      zone: "example.com",
      nameservers: ["ns1.example-dns.net", "ns2.example-dns.net"],
    });
  });

  test("returns an unknown host when no candidate has nameservers", async () => {
    const detector = new NameserverDnsHostDetector({ resolver: createResolver({}) });

    await expect(detector.detect("docs.example.com")).resolves.toEqual(UNKNOWN_DNS_HOST);
  });

  test("returns an unknown host when a more specific lookup fails", async () => {
    const onLookupError = vi.fn();
    const detector = new NameserverDnsHostDetector({
      resolver: createResolver({
        "docs.example.com": new Error("SERVFAIL"),
        "example.com": ["ada.ns.cloudflare.com"],
      }),
      onLookupError,
    });

    await expect(detector.detect("docs.example.com")).resolves.toEqual(UNKNOWN_DNS_HOST);
    expect(onLookupError).toHaveBeenCalledWith("docs.example.com", expect.any(Error));
  });

  test("ignores a failed lookup that is less specific than the zone", async () => {
    const onLookupError = vi.fn();
    const detector = new NameserverDnsHostDetector({
      resolver: createResolver({
        "docs.example.com": [],
        "example.com": ["ns1.digitalocean.com", "ns2.digitalocean.com"],
        "com": new Error("unused"),
      }),
      onLookupError,
    });

    await expect(detector.detect("docs.example.com")).resolves.toMatchObject({ provider: "digitalocean" });
    expect(onLookupError).not.toHaveBeenCalled();
  });

  test("gives up with an unknown host when the lookups pass the time budget", async () => {
    const resolver: NameserverResolver = {
      lookupNameservers: (_name, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    };
    const detector = new NameserverDnsHostDetector({ resolver, timeoutMs: 10, onLookupError: vi.fn() });

    await expect(detector.detect("docs.example.com")).resolves.toEqual(UNKNOWN_DNS_HOST);
  });
});

function createDohFetch(body: unknown) {
  return vi.fn<typeof fetch>(async () => Response.json(body));
}

function createResolver(answers: Record<string, string[] | Error>) {
  return {
    lookupNameservers: vi.fn(async (name: string) => {
      const answer = answers[name] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  } satisfies NameserverResolver;
}
