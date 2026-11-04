"use client";

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { RuntimeMdxContent } from "@/src/runtime/runtime-mdx-content";
import type { RuntimeFeatureConfig } from "@/src/runtime/runtime-source";
import type { RuntimeMdxDocument } from "@doxahq/mdx-runtime";

import { components, elements } from "@/src/lib/components";
import {
  splitEndpointDocument,
  type EndpointCodeSample,
} from "@/src/lib/endpoint-document";
import { readApiBaseUrl, withApiBaseUrl } from "@/src/lib/endpoint-sample-url";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/src/components/ui/dialog";
import {
  CodeCard,
  CodeCardTitle,
  StatusTabs,
} from "@/src/components/api-reference/code-card";
import { EndpointBar } from "@/src/components/api-reference/endpoint-bar";
import { EndpointChromeContext } from "@/src/components/api-reference/endpoint-context";
import { RequestClientSelect } from "@/src/components/api-reference/request-client-select";
import {
  loadStoredRequestClient,
  saveStoredRequestClient,
  selectRequestSample,
} from "@/src/components/api-reference/request-clients";

const TRY_IT_HASH = "#try-it";

function loadPlayground() {
  return import("@/src/components/api-reference/endpoint-playground");
}

/** Most readers never open the playground, so its code loads on demand. */
const EndpointPlayground = lazy(() =>
  loadPlayground().then((module) => ({ default: module.EndpointPlayground }))
);

/** The frame of the panel while its code loads, in place of a spinner. */
function PlaygroundFrame() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <div className="h-[3.0625rem] shrink-0 border-b" />
      <div className="grid min-h-0 flex-1 md:grid-cols-2 md:divide-x">
        <div />
        <div />
      </div>
    </div>
  );
}

/**
 * Reference layout for a generated REST endpoint page.
 *
 * Everything a reader needs to send the request sits in one full-width stack at
 * the top: the endpoint bar, then the request sample and the response sample.
 * The parameter groups and the prose follow underneath, so the page reads top
 * to bottom on every viewport. The playground opens in a modal over this page.
 * `#try-it` opens it too, and a link never sends a request.
 */
export function ApiReferenceBody({
  document,
  method,
  path,
  features,
}: {
  document: RuntimeMdxDocument;
  method: string;
  path: string;
  features: RuntimeFeatureConfig;
}) {
  const endpoint = useMemo(() => splitEndpointDocument(document), [document]);
  const [tryItOpen, setTryItOpen] = useState(false);
  const tryItRef = useRef<HTMLButtonElement>(null);
  const statuses = useMemo(
    () => endpoint.responses.map((response) => response.status ?? "200"),
    [endpoint.responses]
  );
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const activeStatus = selectedStatus ?? statuses[0] ?? "";
  const activeResponse =
    endpoint.responses.find((response) => response.status === activeStatus) ??
    endpoint.responses[0];

  // The owner's setting, never the page's own baseUrl (SEC-010).
  const playgroundBaseUrl = features.apiPlayground ? features.apiPlaygroundBaseUrl : undefined;
  const apiBaseUrl = readApiBaseUrl(playgroundBaseUrl);
  const requestSamples = useMemo(
    () => endpoint.request.map((sample) => withApiBaseUrl(sample, path, apiBaseUrl)),
    [endpoint.request, path, apiBaseUrl]
  );
  const requestSample = selectRequestSample(requestSamples, selectedClient);
  const requestClients = requestSamples.map((sample) => sample.client);

  useEffect(() => {
    const storedClient = loadStoredRequestClient();
    setSelectedClient(
      storedClient &&
        endpoint.request.some((sample) => sample.client === storedClient)
        ? storedClient
        : null
    );
  }, [endpoint.request]);

  useEffect(() => {
    if (!playgroundBaseUrl) return;
    const openFromHash = () => {
      if (window.location.hash === TRY_IT_HASH) setTryItOpen(true);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [playgroundBaseUrl]);

  function selectRequestClient(client: string): void {
    setSelectedClient(client);
    saveStoredRequestClient(client);
  }

  return (
    <div className="mt-8 min-w-0">
      <EndpointBar
        method={method}
        path={path}
        baseUrl={apiBaseUrl}
        {...(playgroundBaseUrl
          ? {
              tryItRef,
              onOpenTryIt: () => setTryItOpen(true),
              onTryItIntent: () => void loadPlayground(),
            }
          : {})}
      />

      {playgroundBaseUrl && (
        <Dialog open={tryItOpen} onOpenChange={setTryItOpen}>
          <DialogContent
            aria-describedby={undefined}
            // Radix returns focus only to its own trigger, and this has none.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              tryItRef.current?.focus();
            }}
            className="flex h-[min(90dvh,60rem)] w-[min(96vw,84rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-md:h-dvh max-md:w-screen max-md:rounded-none max-md:border-0"
          >
            <DialogTitle className="sr-only">
              Try {method.toUpperCase()} {path}
            </DialogTitle>
            <Suspense fallback={<PlaygroundFrame />}>
              <EndpointPlayground
                method={method}
                path={path}
                baseUrl={playgroundBaseUrl}
                parameters={endpoint.parameters}
                onClose={() => setTryItOpen(false)}
                onSampleClientChange={setSelectedClient}
                {...(endpoint.responses[0]
                  ? {
                      exampleResponse: {
                        status: endpoint.responses[0].status ?? "200",
                        text: endpoint.responses[0].text,
                        ...(endpoint.responses[0].detail
                          ? { contentType: endpoint.responses[0].detail }
                          : {}),
                      },
                    }
                  : {})}
              />
            </Suspense>
          </DialogContent>
        </Dialog>
      )}

      <div className="not-prose mt-4 grid min-w-0 gap-4">
        {requestSample && (
          <CodeCard
            heading={<CodeCardTitle>{requestSample.label}</CodeCardTitle>}
            detail={
              <RequestClientSelect
                clients={requestClients}
                active={requestSample.client}
                onSelect={selectRequestClient}
              />
            }
            copyText={requestSample.text}
          >
            <SampleContent sample={requestSample} document={document} />
          </CodeCard>
        )}

        {activeResponse && (
          <CodeCard
            heading={
              <StatusTabs
                statuses={statuses}
                active={activeStatus}
                onSelect={setSelectedStatus}
              />
            }
            detail={activeResponse.detail}
            copyText={activeResponse.text}
          >
            <SampleContent sample={activeResponse} document={document} />
          </CodeCard>
        )}
      </div>

      <div className="prose-content min-w-0">
        <EndpointChromeContext.Provider value={true}>
          <RuntimeMdxContent
            document={endpoint.content}
            components={components}
            elements={elements}
          />
        </EndpointChromeContext.Provider>
      </div>
    </div>
  );
}

/**
 * A bare `pre` for card bodies. The shared `pre` adds its own margin and copy
 * button, which would sit on top of the card's copy button and push the sample
 * away from the card edge.
 */
function CardPre({
  children,
  raw,
  ...props
}: ComponentProps<"pre"> & { raw?: string }) {
  void raw;
  return <pre {...props}>{children}</pre>;
}

const cardComponents = { ...components, pre: CardPre };

/**
 * Renders a sample's own children, so the card supplies the frame instead of
 * the `ApiRequestExample` and `ApiResponseExample` wrappers.
 */
function SampleContent({
  sample,
  document,
}: {
  sample: EndpointCodeSample;
  document: RuntimeMdxDocument;
}) {
  return (
    <RuntimeMdxContent
      document={{
        frontmatter: document.frontmatter,
        nodes: sample.node.children ?? [],
      }}
      components={cardComponents}
    />
  );
}
