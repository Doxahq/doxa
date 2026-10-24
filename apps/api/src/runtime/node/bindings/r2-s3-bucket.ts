import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

/** S3 limits DeleteObjects to 1,000 keys per request. */
const MAX_DELETE_KEYS = 1000;
const DEFAULT_LIST_LIMIT = 1000;

export interface S3BucketConfig {
  /** https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createR2S3Client(config: S3BucketConfig): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

/**
 * The `R2Bucket` binding over the R2 S3 API, for the Node server. It covers
 * what the API uses: `get`, `head`, `put`, `delete` and `list` with prefix,
 * limit and cursor. Conditional and ranged requests and multipart uploads
 * throw, so a new use fails loudly in tests instead of acting differently.
 */
export class S3R2Bucket implements R2Bucket {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async head(key: string): Promise<R2Object | null> {
    try {
      const output = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return new S3R2Object(key, {
        size: output.ContentLength ?? 0,
        etag: output.ETag,
        uploaded: output.LastModified,
        httpMetadata: httpMetadataOf(output),
        customMetadata: output.Metadata,
      });
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
  }

  get(key: string, options: R2GetOptions & { onlyIf: R2Conditional | Headers }): Promise<R2ObjectBody | R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    assertNoUnsupportedOptions("get", options, ["onlyIf", "range", "ssecKey"]);
    try {
      const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = output.Body ? await output.Body.transformToByteArray() : new Uint8Array();
      return new S3R2ObjectBody(
        key,
        {
          size: output.ContentLength ?? bytes.byteLength,
          etag: output.ETag,
          uploaded: output.LastModified,
          httpMetadata: httpMetadataOf(output),
          customMetadata: output.Metadata,
        },
        bytes,
      );
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
  }

  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions & { onlyIf: R2Conditional | Headers },
  ): Promise<R2Object | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object>;
  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    assertNoUnsupportedOptions("put", options, ["onlyIf", "md5", "sha1", "sha256", "sha384", "sha512", "ssecKey", "storageClass"]);
    const body = await toBytes(value);
    const httpMetadata = options?.httpMetadata instanceof Headers ? fromHeaders(options.httpMetadata) : options?.httpMetadata;
    const output = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ContentType: httpMetadata?.contentType,
        ContentLanguage: httpMetadata?.contentLanguage,
        ContentDisposition: httpMetadata?.contentDisposition,
        ContentEncoding: httpMetadata?.contentEncoding,
        CacheControl: httpMetadata?.cacheControl,
        Expires: httpMetadata?.cacheExpiry,
        Metadata: options?.customMetadata,
      }),
    );
    return new S3R2Object(key, {
      size: body.byteLength,
      etag: output.ETag,
      uploaded: new Date(),
      httpMetadata,
      customMetadata: options?.customMetadata,
    });
  }

  async delete(keys: string | string[]): Promise<void> {
    if (typeof keys === "string") {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: keys }));
      return;
    }
    for (let start = 0; start < keys.length; start += MAX_DELETE_KEYS) {
      const batch = keys.slice(start, start + MAX_DELETE_KEYS);
      const output = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed = output.Errors ?? [];
      if (failed.length > 0) {
        const first = failed[0];
        throw new Error(`R2 could not delete ${failed.length} of ${batch.length} objects. First: ${first?.Key}: ${first?.Message}`);
      }
    }
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const output = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: options?.prefix,
        MaxKeys: options?.limit ?? DEFAULT_LIST_LIMIT,
        ContinuationToken: options?.cursor,
        Delimiter: options?.delimiter,
        StartAfter: options?.startAfter,
      }),
    );
    const objects: R2Object[] = (output.Contents ?? []).flatMap((entry) =>
      entry.Key
        ? [new S3R2Object(entry.Key, { size: entry.Size ?? 0, etag: entry.ETag, uploaded: entry.LastModified })]
        : [],
    );
    const delimitedPrefixes = (output.CommonPrefixes ?? []).flatMap((entry) => (entry.Prefix ? [entry.Prefix] : []));
    return output.IsTruncated && output.NextContinuationToken
      ? { objects, delimitedPrefixes, truncated: true, cursor: output.NextContinuationToken }
      : { objects, delimitedPrefixes, truncated: false };
  }

  createMultipartUpload(): Promise<R2MultipartUpload> {
    return Promise.reject(unsupported("createMultipartUpload"));
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw unsupported("resumeMultipartUpload");
  }
}

interface ObjectInfo {
  size: number;
  etag: string | undefined;
  uploaded: Date | undefined;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

class S3R2Object implements R2Object {
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly checksums: R2Checksums = { toJSON: () => ({}) };
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
  readonly storageClass = "Standard";

  constructor(
    readonly key: string,
    info: ObjectInfo,
  ) {
    const etag = unquote(info.etag ?? "");
    this.version = etag;
    this.size = info.size;
    this.etag = etag;
    this.httpEtag = `"${etag}"`;
    this.uploaded = info.uploaded ?? new Date(0);
    this.httpMetadata = info.httpMetadata;
    this.customMetadata = info.customMetadata;
  }

  writeHttpMetadata(headers: Headers): void {
    const metadata = this.httpMetadata;
    if (!metadata) return;
    if (metadata.contentType) headers.set("content-type", metadata.contentType);
    if (metadata.contentLanguage) headers.set("content-language", metadata.contentLanguage);
    if (metadata.contentDisposition) headers.set("content-disposition", metadata.contentDisposition);
    if (metadata.contentEncoding) headers.set("content-encoding", metadata.contentEncoding);
    if (metadata.cacheControl) headers.set("cache-control", metadata.cacheControl);
    if (metadata.cacheExpiry) headers.set("expires", metadata.cacheExpiry.toUTCString());
  }
}

/** An object with its whole body in memory. The API reads small documents and assets only. */
class S3R2ObjectBody extends S3R2Object implements R2ObjectBody {
  private used = false;

  constructor(
    key: string,
    info: ObjectInfo,
    private readonly bytesRead: Uint8Array,
  ) {
    super(key, info);
  }

  get body(): ReadableStream {
    const bytes = this.consume();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  get bodyUsed(): boolean {
    return this.used;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Uint8Array(this.consume()).buffer;
  }

  async bytes(): Promise<Uint8Array> {
    return this.consume();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.consume());
  }

  async json<T>(): Promise<T> {
    return JSON.parse(await this.text());
  }

  async blob(): Promise<Blob> {
    return new Blob([new Uint8Array(this.consume())], { type: this.httpMetadata?.contentType ?? "" });
  }

  /** A body reads once, as in Workers. */
  private consume(): Uint8Array {
    if (this.used) throw new TypeError(`The body of ${this.key} was already read.`);
    this.used = true;
    return this.bytesRead;
  }
}

interface HttpMetadataSource {
  ContentType?: string;
  ContentLanguage?: string;
  ContentDisposition?: string;
  ContentEncoding?: string;
  CacheControl?: string;
  Expires?: Date;
}

function httpMetadataOf(output: HttpMetadataSource): R2HTTPMetadata {
  return {
    contentType: output.ContentType,
    contentLanguage: output.ContentLanguage,
    contentDisposition: output.ContentDisposition,
    contentEncoding: output.ContentEncoding,
    cacheControl: output.CacheControl,
    cacheExpiry: output.Expires,
  };
}

function fromHeaders(headers: Headers): R2HTTPMetadata {
  const expires = headers.get("expires");
  return {
    contentType: headers.get("content-type") ?? undefined,
    contentLanguage: headers.get("content-language") ?? undefined,
    contentDisposition: headers.get("content-disposition") ?? undefined,
    contentEncoding: headers.get("content-encoding") ?? undefined,
    cacheControl: headers.get("cache-control") ?? undefined,
    cacheExpiry: expires ? new Date(expires) : undefined,
  };
}

async function toBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function assertNoUnsupportedOptions(method: string, options: object | undefined, names: readonly string[]): void {
  if (!options) return;
  const used = Object.entries(options)
    .filter(([name, value]) => names.includes(name) && value !== undefined)
    .map(([name]) => name);
  if (used.length > 0) {
    throw unsupported(`${method} with ${used.join(", ")}`);
  }
}

function unsupported(feature: string): Error {
  return new Error(`R2 ${feature} is not supported by the S3 adapter of the Node server.`);
}

function isNotFound(cause: unknown): boolean {
  if (!(cause instanceof S3ServiceException)) return false;
  return cause.$metadata.httpStatusCode === 404 || cause.name === "NoSuchKey" || cause.name === "NotFound";
}

function unquote(etag: string): string {
  return etag.replace(/^"(.*)"$/, "$1");
}
