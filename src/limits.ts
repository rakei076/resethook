/** Read at most `max` bytes of a body: a hostile sender or receiver must not make us buffer megabytes. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<{ text: string; tooBig: boolean }> {
  const reader = body?.getReader();
  if (!reader) return { text: "", tooBig: false };
  const decoder = new TextDecoder();
  let text = "";
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), tooBig: false };
    n += value.length;
    if (n > max) {
      await reader.cancel();
      return { text: (text + decoder.decode(value, { stream: true })).slice(0, max), tooBig: true };
    }
    text += decoder.decode(value, { stream: true });
  }
}
