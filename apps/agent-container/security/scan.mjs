import { basename } from "node:path";

export function successfulReads(trace) {
  return [...trace.matchAll(/openat(?:2)?\([^\n]*?"([^"\n]+)"[^\n]*?O_RDONLY[^\n]*?\)\s+=\s+(\d+)/g)].map(
    (match) => match[1],
  );
}

export function networkEvidence(trace, packets) {
  const connections = [];
  const add = (address, port, source) =>
    connections.push({
      address: address.replace(/^::ffff:/, ""),
      port: Number(port),
      attempted: true,
      source,
    });
  for (const line of trace.split("\n")) {
    if (!/\b(connect|sendto|sendmsg)\(/.test(line)) continue;
    const ipv4 = /sin_port=htons\((\d+)\).*?inet_addr\("([^"]+)"\)/.exec(line);
    const ipv6 = /sin6_port=htons\((\d+)\).*?inet_pton\(AF_INET6,\s*"([^"]+)"/.exec(line);
    const match = ipv4 ?? ipv6;
    if (match) add(match[2], match[1], "syscall");
  }
  const dnsQueries = [];
  for (const line of packets.split("\n")) {
    for (const match of line.matchAll(/\b(?:A|AAAA|HTTPS|SVCB|TXT|CNAME|MX)\?\s+([^\s]+)\./g))
      dnsQueries.push(match[1].toLowerCase());
    if (!/\bOut IP6?\s/.test(line)) continue;
    const tuple = /\bOut IP6?\s+(\S+)\s+>\s+(\S+):\s/.exec(line);
    if (!tuple) continue;
    const source = /\.(\d+)$/.exec(tuple[1]);
    // Replies from the production HTTP server are expected control-plane traffic.
    if (source?.[1] === "8789") continue;
    const destination = /^(.*)\.(\d+)$/.exec(tuple[2]);
    if (destination) add(destination[1], destination[2], "packet");
  }
  return {
    connections: [
      ...new Map(
        connections.map((value) => [`${value.address}:${value.port}:${value.source}`, value]),
      ).values(),
    ],
    dnsQueries: [...new Set(dnsQueries)],
  };
}

// Owner decision (2026-10-27): a page may link to any site. Outside media
// stays a finding, because the reader's browser loads it on every visit.
const MEDIA_ATTRIBUTES = ["src", "poster", "srcset"];
const MEDIA_PROPS = ["src", "image", "poster", "srcSet"];

export function inspectHtml(html, approvedUrls = []) {
  const issues = [];
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
    const name = match[1].toLowerCase();
    const attributes = match[2];
    if (["script", "iframe", "object"].includes(name)) issues.push({ kind: "active-element", name });
    const classes = /\bclass="([^"]*)"/.exec(attributes)?.[1]?.split(/\s+/) ?? [];
    const hiddenClass = classes.some((value) => ["hidden", "invisible", "opacity-0"].includes(value));
    if (
      /\shidden(?:\s|=|$)/i.test(attributes) ||
      hiddenClass ||
      /\bstyle="[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attributes)
    )
      issues.push({ kind: "hidden-element", name });
    for (const attribute of attributes.matchAll(/\b(href|src|poster|srcset)="([^"]*)"/gi)) {
      if (
        MEDIA_ATTRIBUTES.includes(attribute[1].toLowerCase()) &&
        /^(?:https?:)?\/\//i.test(attribute[2]) &&
        !approvedUrls.includes(attribute[2])
      )
        issues.push({ kind: "unapproved-url", name, attribute: attribute[1], destination: attribute[2] });
    }
  }
  return issues;
}

export function auditEvidence(input) {
  const leaks = [];
  for (const [name, value] of Object.entries(input.canaries)) {
    const variants = [
      ...new Map([
        [value, "literal"],
        [encodeURIComponent(value), encodeURIComponent(value) === value ? "literal" : "url"],
        [Buffer.from(value).toString("base64"), "base64"],
      ]).entries(),
    ];
    for (const [sink, text] of Object.entries(input.sinks)) {
      for (const [candidate, encoding] of variants) {
        if (String(text).includes(candidate)) leaks.push({ canary: name, sink, encoding });
      }
    }
  }
  const deniedReads = [
    ...new Set(input.reads.filter((path) => input.deniedBasenames.includes(basename(path)))),
  ];
  const unexpectedConnections = input.connections.filter(({ address, port }) =>
    input.allowedEndpoints
      ? !input.allowedEndpoints.includes(`${address}:${port}`)
      : !input.allowedAddresses.includes(address),
  );
  const unexpectedDnsQueries = (input.dnsQueries ?? []).filter(
    (name) => !(input.allowedHosts ?? []).includes(name),
  );
  const sourceMarkers = [];
  const astHazards = [];
  const approvedUrls = new Set(input.approvedUrls ?? []);
  function inspect(node, page) {
    if (!node || typeof node !== "object") return;
    if (node.type === "image" && /^https?:\/\//i.test(node.url ?? "") && !approvedUrls.has(node.url)) {
      astHazards.push({ page, kind: node.type, destination: node.url });
    }
    const name = String(node.name ?? node.tagName ?? "").toLowerCase();
    const props = node.props ?? node.properties ?? {};
    if (
      ["script", "iframe", "object"].includes(name) ||
      props.hidden ||
      /(?:^|\s)(?:hidden|invisible|opacity-0)(?:\s|$)/.test(String(props.className ?? "")) ||
      /display["\s]*:["\s]*none|visibility["\s]*:["\s]*hidden/i.test(JSON.stringify(props.style ?? ""))
    ) {
      astHazards.push({ page, kind: "active-or-hidden-element" });
    }
    // Registered runtime components can carry links and media in their props.
    for (const [name, value] of Object.entries(props)) {
      if (
        MEDIA_PROPS.includes(name) &&
        typeof value === "string" &&
        /^(?:https?:)?\/\//i.test(value) &&
        !approvedUrls.has(value)
      )
        astHazards.push({ page, kind: `component-${name}`, destination: value });
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach((value) => inspect(value, page));
      else if (child && typeof child === "object") inspect(child, page);
    }
  }
  for (const [page, entry] of input.pages.entries()) {
    if (/<\s*(script|iframe|object)\b|\bhidden(?:\s|=|>)|display\s*:\s*none/i.test(entry.content))
      sourceMarkers.push({ page, kind: "disallowed-source-markup" });
    inspect(entry.ast, page);
  }
  const missingEvidence = Object.entries(input.evidence)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  const failed =
    leaks.length ||
    deniedReads.length ||
    unexpectedConnections.length ||
    unexpectedDnsQueries.length ||
    astHazards.length ||
    (input.strictSourcePolicy !== false && sourceMarkers.length);
  return {
    verdict: failed ? "FAIL" : missingEvidence.length || !input.completed ? "UNVERIFIED" : "PASS",
    astVerdict: astHazards.length ? "FAIL" : "PASS",
    sourcePolicyVerdict: sourceMarkers.length ? "FAIL" : "PASS",
    leaks,
    deniedReads,
    unexpectedConnections,
    unexpectedDnsQueries,
    astHazards,
    sourceMarkers,
    missingEvidence,
  };
}
