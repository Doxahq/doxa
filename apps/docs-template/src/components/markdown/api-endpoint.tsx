"use client";

import { Children, isValidElement, type ReactNode } from "react";

import type {
  ApiParameterDefinition,
  ApiParameterLocation,
} from "@/src/lib/endpoint-document";
import { EndpointBar } from "@/src/components/api-reference/endpoint-bar";
import { useLayoutOwnsEndpointChrome } from "@/src/components/api-reference/endpoint-context";

export {
  buildBrowserRequest,
  isAuthParameter,
  requestInputParameters,
  type BrowserRequestInput,
} from "@/src/lib/api-request";
export type { ApiParameterDefinition, ApiParameterLocation };

interface ApiParamProps extends ApiParameterDefinition {
  /** Read from the node tree for the playground. The row does not draw it. */
  enum?: string;
  default?: string;
  children?: ReactNode;
}

/**
 * One documented field: the name, its type, and whether it is required, then
 * the description underneath.
 *
 * The group heading already names the location (Path, Query, Body), so the row
 * does not repeat it.
 */
export function ApiParam({ name, type, required, children }: ApiParamProps) {
  return (
    <div className="border-t border-border/60 py-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <code className="font-code text-[0.8125rem] font-semibold break-all text-foreground">
          {name}
        </code>
        <span className="font-code rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
          {type}
        </span>
        {required && (
          <span className="font-code rounded bg-destructive/10 px-1.5 py-0.5 text-[0.65rem] text-destructive">
            required
          </span>
        )}
      </div>
      {children && (
        <div className="mt-1.5 text-sm leading-relaxed text-muted-foreground [&>p]:m-0 [&>p+p]:mt-2">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A titled group of fields. `detail` carries a content type when the generator
 * supplies one, matching the reference convention of showing it beside Body and
 * Response headings.
 */
export function ApiParams({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <section className="not-prose mt-10">
      <div className="flex items-baseline justify-between gap-3 border-b pb-2">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {detail && (
          <span className="font-code text-xs text-muted-foreground">
            {detail}
          </span>
        )}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  );
}

export function ApiRequestExample({
  client,
  label,
  lang,
  children,
}: {
  client?: string;
  lang?: string;
  label: string;
  children?: ReactNode;
}) {
  void client;
  return (
    <FallbackExample title={label} detail={lang}>
      {children}
    </FallbackExample>
  );
}

export function ApiResponseExample({
  status,
  contentType,
  children,
}: {
  status: string | number;
  contentType?: string;
  children?: ReactNode;
}) {
  return (
    <FallbackExample title={`Response ${status}`} detail={contentType}>
      {children}
    </FallbackExample>
  );
}

/**
 * Used when the page is not rendered through the reference layout — a page
 * authored by hand, or the compiled-MDX content path. The layout extracts these
 * samples into its rail before React sees them.
 */
function FallbackExample({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <section className="not-prose mt-6 overflow-hidden rounded-xl border bg-card/60">
      <header className="flex items-center gap-2 border-b bg-muted/40 py-1.5 pr-1.5 pl-3">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium">{title}</h3>
        {detail && (
          <span className="font-code text-[0.7rem] text-muted-foreground">
            {detail}
          </span>
        )}
      </header>
      <div className="overflow-auto text-[0.8125rem] [&>pre]:m-0 [&>pre]:rounded-none [&>pre]:border-0 [&>pre]:bg-transparent [&>pre]:p-3">
        {children}
      </div>
    </section>
  );
}

export function ApiEndpoint({
  method,
  path,
  children,
}: {
  method: string;
  path: string;
  baseUrl?: string;
  children?: ReactNode;
}) {
  const layoutOwnsChrome = useLayoutOwnsEndpointChrome();

  if (layoutOwnsChrome) {
    return <div className="not-prose">{children}</div>;
  }

  return (
    <div className="not-prose mt-8">
      <EndpointBar method={method} path={path} />
      {firstRequestExampleOnly(children)}
    </div>
  );
}

function firstRequestExampleOnly(children: ReactNode): ReactNode {
  let foundRequest = false;
  return Children.toArray(children).filter((child) => {
    if (!isValidElement(child) || child.type !== ApiRequestExample) return true;
    if (foundRequest) return false;
    foundRequest = true;
    return true;
  });
}

/**
 * Kept for callers that read parameters from rendered React children. The
 * reference layout reads them from the parsed node tree instead, which works
 * the same way on the server and in the browser.
 */
export function collectApiParameterDefinitions(
  children: ReactNode
): ApiParameterDefinition[] {
  const definitions: ApiParameterDefinition[] = [];

  function visit(nodes: ReactNode): void {
    Children.forEach(nodes, (child) => {
      if (isValidElement<ApiParamProps>(child) && child.type === ApiParam) {
        definitions.push({
          name: child.props.name,
          type: child.props.type,
          location: child.props.location,
          required: child.props.required,
        });
      }
      if (isValidElement<{ children?: ReactNode }>(child)) {
        visit(child.props.children);
      }
    });
  }

  visit(children);
  return definitions;
}
