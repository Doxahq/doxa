interface EventSource {
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

interface ResponseEventSource extends EventSource {
  writableEnded: boolean;
}

export interface GenerationRequestCancellation {
  abortController: AbortController;
  dispose(): void;
}

export function bindGenerationRequestCancellation(
  request: EventSource,
  response: ResponseEventSource,
): GenerationRequestCancellation {
  const abortController = new AbortController();
  const abort = () => {
    if (!abortController.signal.aborted) {
      abortController.abort(new Error("Generation request disconnected."));
    }
  };
  const abortOnPrematureResponseClose = () => {
    if (!response.writableEnded) abort();
  };

  request.once("aborted", abort);
  response.once("close", abortOnPrematureResponseClose);

  return {
    abortController,
    dispose() {
      request.off("aborted", abort);
      response.off("close", abortOnPrematureResponseClose);
    },
  };
}
