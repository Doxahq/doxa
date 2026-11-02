"use client";

import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { RuntimeMdxContent } from "@/src/runtime/runtime-mdx-content";
import type { RuntimeFeatureConfig } from "@/src/runtime/runtime-source";
import type { RuntimeMdxDocument } from "@doxahq/mdx-runtime";

import { components, elements } from "@/src/lib/components";
import {
  splitEndpointDocument,
  type EndpointCodeSample,
} from "@/src/lib/endpoint-document";
import {
  Collapsible,
  CollapsibleContent,
} from "@/src/components/ui/collapsible";
import {
  CodeCard,
  CodeCardTitle,
  StatusTabs,
} from "@/src/components/api-reference/code-card";
import { EndpointBar } from "@/src/components/api-reference/endpoint-bar";
import { EndpointChromeContext } from "@/src/components/api-reference/endpoint-context";
import { EndpointPlayground } from "@/src/components/api-reference/endpoint-playground";
import { RequestClientSelect } from "@/src/components/api-reference/request-client-select";
import {
  loadStoredRequestClient,
  saveStoredRequestClient,
  selectRequestSample,
} from "@/src/components/api-reference/request-clients";

/**
 * Reference layout for a generated REST endpoint page.
 *
 * Everything a reader needs to send the request sits in one full-width stack at
 * the top: the endpoint bar, then the playground when it is open, then the
 * request sample and the response sample. The parameter groups and the prose
 * follow underneath, so the page reads top to bottom on every viewport.
 *
 * The playground opens between the bar and the samples. The bar is the anchor a
 * reader is looking at when they press the control, and it does not move, so
 * the panel grows into view instead of pushing the page out from under them.
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
  const requestSample = selectRequestSample(endpoint.request, selectedClient);
  const requestClients = endpoint.request.map((sample) => sample.client);

  useEffect(() => {
    const storedClient = loadStoredRequestClient();
    setSelectedClient(
      storedClient &&
        endpoint.request.some((sample) => sample.client === storedClient)
        ? storedClient
        : null
    );
  }, [endpoint.request]);

  function selectRequestClient(client: string): void {
    setSelectedClient(client);
    saveStoredRequestClient(client);
  }

  return (
    <div className="mt-8 min-w-0">
      <EndpointBar
        method={method}
        path={path}
        tryItOpen={tryItOpen}
        {...(playgroundBaseUrl
          ? { onToggleTryIt: () => setTryItOpen((open) => !open) }
          : {})}
      />

      {playgroundBaseUrl && (
        <Collapsible open={tryItOpen} onOpenChange={setTryItOpen}>
          {/*
           * The top padding lives inside the animated box, so it collapses with
           * the panel. Spacing applied outside would survive the close and drop
           * the cards by one gap after the animation settled.
           */}
          <CollapsibleContent className="endpoint-try-it">
            <div className="pt-4">
              <CodeCard
                heading={<CodeCardTitle>Try it</CodeCardTitle>}
                bodyClassName="max-h-none"
              >
                <EndpointPlayground
                  method={method}
                  path={path}
                  baseUrl={playgroundBaseUrl}
                  parameters={endpoint.parameters}
                />
              </CodeCard>
            </div>
          </CollapsibleContent>
        </Collapsible>
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
