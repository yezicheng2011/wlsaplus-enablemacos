import { Injectable } from '@angular/core';
import type { TranslationResult } from './models';

@Injectable({ providedIn: 'root' })
export class TranslationService {
  async translate(text: string, source: string, target: string): Promise<TranslationResult> {
    const trimmed = text.trim();
    if (!trimmed) return { text: '', detectedLanguage: source };
    if (window.wlsaplus) {
      try {
        return await window.wlsaplus.translator.translate(trimmed, source, target);
      } catch {
        return this.translateWithMyMemory(trimmed, source, target);
      }
    }
    return this.translateWithMyMemory(trimmed, source, target);
  }

  captureRegion(): Promise<string | null> {
    return Promise.reject(new Error('Screen translation is not available on macOS.'));
  }

  private async translateWithMyMemory(text: string, source: string, target: string): Promise<TranslationResult> {
    const chunks = this.splitTextByBytes(text, 450);
    const translations: string[] = [];
    let detectedLanguage = source;

    for (const chunk of chunks) {
      const params = new URLSearchParams({
        q: chunk,
        langpair: `${source === 'auto' ? 'Autodetect' : source}|${target}`,
      });
      const url = `https://api.mymemory.translated.net/get?${params}`;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 12_000);
      let response: Response;
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new Error('Translation timed out. Check your network and try again.');
        }
        throw error;
      } finally {
        window.clearTimeout(timer);
      }
      if (!response.ok) throw new Error('Translation service is unavailable. Please try again later.');
      const data = await response.json();
      const parsed = this.parseMyMemory(data, source);
      translations.push(parsed.text);
      if (detectedLanguage === 'auto' && parsed.detectedLanguage !== 'auto') detectedLanguage = parsed.detectedLanguage;
    }

    return { text: translations.join(''), detectedLanguage };
  }

  private splitTextByBytes(text: string, maximumBytes: number): string[] {
    const chunks: string[] = [];
    const encoder = new TextEncoder();
    let chunk = '';
    let chunkBytes = 0;
    for (const character of text) {
      const characterBytes = encoder.encode(character).length;
      if (chunk && chunkBytes + characterBytes > maximumBytes) {
        chunks.push(chunk);
        chunk = '';
        chunkBytes = 0;
      }
      chunk += character;
      chunkBytes += characterBytes;
    }
    if (chunk) chunks.push(chunk);
    return chunks;
  }

  private parseMyMemory(data: unknown, source: string): TranslationResult {
    const result = data as { responseStatus?: number; responseDetails?: string; responseData?: { translatedText?: string; detectedLanguage?: string } };
    if (result?.responseStatus !== 200 || typeof result?.responseData?.translatedText !== 'string') {
      throw new Error(typeof result?.responseDetails === 'string' && result.responseDetails.trim() ? result.responseDetails : 'The translation response was invalid.');
    }
    return {
      text: result.responseData.translatedText,
      detectedLanguage: typeof result.responseData.detectedLanguage === 'string' ? result.responseData.detectedLanguage : source,
    };
  }
}
