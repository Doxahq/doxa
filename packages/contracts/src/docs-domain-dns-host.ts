import { z } from "zod";

/**
 * DNS hosts that Doxa recognizes from a zone's nameservers. The DNS host is
 * the service that answers for the zone, which is where the CNAME record goes.
 * It can differ from the registrar that sold the domain.
 */
export const DNS_HOST_PROVIDERS = [
  "cloudflare",
  "namecheap",
  "godaddy",
  "route53",
  "vercel",
  "porkbun",
  "digitalocean",
] as const;

export const dnsHostProviderSchema = z.enum(DNS_HOST_PROVIDERS);

/**
 * The DNS host of a custom docs domain, from a public DNS lookup.
 * `zone` is null when the lookup found no delegated zone, and `provider` is
 * null when the nameservers belong to no recognized DNS host (or to more than
 * one). The dashboard then shows the generic DNS steps.
 */
export const docsDomainDnsHostSchema = z.object({
  provider: dnsHostProviderSchema.nullable(),
  zone: z.string().nullable(),
  nameservers: z.array(z.string()),
});

export const docsDomainDnsHostResponseSchema = z.object({
  dnsHost: docsDomainDnsHostSchema,
});

export type DnsHostProvider = z.infer<typeof dnsHostProviderSchema>;
export type DocsDomainDnsHost = z.infer<typeof docsDomainDnsHostSchema>;
export type DocsDomainDnsHostResponse = z.infer<typeof docsDomainDnsHostResponseSchema>;
