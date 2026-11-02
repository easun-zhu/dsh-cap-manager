/**
 * Browser-side file plumbing for import/export: base64 codecs for RPC
 * payloads, archive (un)packing with fflate, and download helpers.
 */

import { unzipSync, zipSync } from 'fflate'
import type { ImportFilePayload } from '../types.ts'

/** Base64-encode bytes in chunks (String.fromCharCode has an argument limit). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk))
  }
  return btoa(binary)
}

/** Decode base64 back to bytes. */
export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  return bytes
}

/** Decode base64 as UTF-8 text (single-file skill exports). */
export function decodeUtf8(base64: string): string {
  return new TextDecoder().decode(fromBase64(base64))
}

/** Unpack one zip archive; directory entries and macOS junk drop out. */
export function unzipFiles(bytes: Uint8Array): ImportFilePayload[] {
  const files: ImportFilePayload[] = []
  for (const [path, data] of Object.entries(unzipSync(bytes))) {
    if (path.endsWith('/') || path.split('/').includes('__MACOSX')) continue
    if (path.endsWith('.DS_Store') || path.endsWith('Thumbs.db') || data.length === 0) continue
    files.push({ path, base64: toBase64(data) })
  }
  return files
}

/** Pack payloads back into a downloadable zip archive. */
export function zipFiles(files: readonly ImportFilePayload[]): Uint8Array {
  const data: Record<string, Uint8Array> = {}
  for (const file of files) data[file.path] = fromBase64(file.base64)
  return zipSync(data)
}

/** Fetch one http(s) URL as bytes; browser CORS rules apply (GitHub raw works). */
export async function fetchUrlBytes(url: string, limitBytes = 10 * 1024 * 1024): Promise<Uint8Array> {
  const parsed = new URL(url.trim())
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unsupported URL scheme: ${parsed.protocol}`)
  }
  const response = await fetch(parsed.href)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > limitBytes) {
    throw new Error(`response exceeds the ${String(Math.floor(limitBytes / 1024))} KB limit`)
  }
  return new Uint8Array(buffer)
}

/** Fetch one http(s) URL as UTF-8 text (mcpServers documents). */
export async function fetchUrlText(url: string, limitBytes = 2 * 1024 * 1024): Promise<string> {
  return new TextDecoder().decode(await fetchUrlBytes(url, limitBytes))
}

/** Trigger one browser download. */
export function downloadBytes(filename: string, bytes: Uint8Array, mime = 'application/octet-stream'): void {
  downloadBlob(filename, new Blob([bytes as BlobPart], { type: mime }))
}

/** Trigger one text download. */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }))
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
}
