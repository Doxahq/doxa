import type { GeneratedPageContent, PageGenerationFailure } from "../types";

export class DocsQualityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsQualityValidationError";
  }
}

export interface TestPageFailure {
  title: string;
  reason: string;
}

export class TestPageGenerationError extends Error {
  failures: TestPageFailure[];
  generatedPages: GeneratedPageContent[];
  outputDir: string;

  constructor(failures: TestPageFailure[], generatedPages: GeneratedPageContent[], outputDir: string) {
    const details = failures
      .map((failure) => `${failure.title}: ${failure.reason}`)
      .join("; ");
    super(`Failed to generate ${failures.length} selected test page(s): ${details}`);
    this.name = "TestPageGenerationError";
    this.failures = failures;
    this.generatedPages = generatedPages;
    this.outputDir = outputDir;
  }
}

export class PageGenerationAbortedError extends Error {
  failure: PageGenerationFailure;
  generatedPages: GeneratedPageContent[];
  skippedPages: PageGenerationFailure[];
  outputDir: string;

  constructor(
    failure: PageGenerationFailure,
    generatedPages: GeneratedPageContent[],
    skippedPages: PageGenerationFailure[],
    outputDir: string,
  ) {
    super(`Generation aborted after page failed: ${failure.title}: ${failure.reason}`);
    this.name = "PageGenerationAbortedError";
    this.failure = failure;
    this.generatedPages = generatedPages;
    this.skippedPages = skippedPages;
    this.outputDir = outputDir;
  }
}
