/**
 * The PostHog sink. It loads `posthog-node`, so only the composition roots
 * import this entry: the API Node origin and the Worker entry points.
 */
export { POSTHOG_PROVIDER, PostHogSink, type PostHogDelivery, type PostHogSinkOptions } from "./posthog-sink";
