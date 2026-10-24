import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { bindGenerationRequestCancellation } from "../src/request-cancellation";

class FakeResponse extends EventEmitter {
  writableEnded = false;
}

describe("generation request cancellation", () => {
  test("aborts when the request is interrupted", () => {
    const request = new EventEmitter();
    const response = new FakeResponse();
    const cancellation = bindGenerationRequestCancellation(request, response);

    request.emit("aborted");

    expect(cancellation.abortController.signal.aborted).toBe(true);
  });

  test("aborts when the response closes before completion", () => {
    const request = new EventEmitter();
    const response = new FakeResponse();
    const cancellation = bindGenerationRequestCancellation(request, response);

    response.emit("close");

    expect(cancellation.abortController.signal.aborted).toBe(true);
  });

  test("does not abort after a completed response closes", () => {
    const request = new EventEmitter();
    const response = new FakeResponse();
    const cancellation = bindGenerationRequestCancellation(request, response);
    response.writableEnded = true;

    response.emit("close");

    expect(cancellation.abortController.signal.aborted).toBe(false);
  });

  test("dispose detaches both event listeners", () => {
    const request = new EventEmitter();
    const response = new FakeResponse();
    const cancellation = bindGenerationRequestCancellation(request, response);

    cancellation.dispose();
    request.emit("aborted");
    response.emit("close");

    expect(cancellation.abortController.signal.aborted).toBe(false);
  });
});
