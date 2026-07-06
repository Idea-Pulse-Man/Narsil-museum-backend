/**
 * S3 image store for the ingestion job.
 * ---------------------------------------------------------------------------
 * Uploads images (artworks + artist portraits) to the public bucket and reports
 * whether an object already exists (so daily reruns skip images we've already
 * stored).
 *
 * Credentials come from the AWS default provider chain — on EC2 that's the
 * instance's IAM role (`narsil-ec2-role`), so no keys are stored anywhere.
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

export class S3ImageStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket = env.aws.s3Bucket,
    private readonly publicBaseUrl = env.aws.s3PublicBaseUrl,
    region = env.aws.region,
  ) {
    this.client = new S3Client({ region });
  }

  /** Public URL an <img src> can load for a given object key. */
  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  /** True when the object already exists in the bucket. */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Upload image bytes and return the public URL. */
  async upload(
    key: string,
    body: Buffer,
    contentType = "image/jpeg",
  ): Promise<string> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    return this.publicUrl(key);
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NotFoundException" ||
    e?.$metadata?.httpStatusCode === 404
  );
}
