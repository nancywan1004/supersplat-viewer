export const VIDEO_EXPORT_WORKER_SOURCE = `
self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    try {
      if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') {
        self.postMessage({ type: 'error', message: 'Worker WebCodecs unavailable' });
        return;
      }
      const cfg = m.config;
      self.__encoder = new VideoEncoder({
        output: async (chunk, meta) => {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          self.postMessage({
            type: 'chunk',
            chunkType: chunk.type,
            timestamp: chunk.timestamp,
            duration: chunk.duration ?? 0,
            data: bytes.buffer,
            meta
          }, [bytes.buffer]);
        },
        error: (err) => self.postMessage({ type: 'error', message: String(err) })
      });
      self.__encoder.configure(cfg);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }
  if (m.type === 'frame') {
    try {
      const b = m.bitmap;
      const vf = new VideoFrame(b, { timestamp: m.timestamp, duration: m.duration });
      self.__encoder.encode(vf, { keyFrame: !!m.keyFrame });
      vf.close();
      if (b && typeof b.close === 'function') b.close();
      self.postMessage({ type: 'frameDone', encodeQueueSize: self.__encoder.encodeQueueSize || 0 });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }
  if (m.type === 'finalize') {
    try {
      await self.__encoder.flush();
      self.__encoder.close();
      self.postMessage({ type: 'done' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }
  if (m.type === 'abort') {
    try {
      if (self.__encoder && self.__encoder.state !== 'closed') self.__encoder.close();
    } catch {}
    self.postMessage({ type: 'aborted' });
  }
};
`;
