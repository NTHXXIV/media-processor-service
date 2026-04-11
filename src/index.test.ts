import { describe, it, expect, vi } from 'vitest';
import { 
  toSecretKey, 
  resolveCallbackSecret, 
  buildMasterPlaylist, 
  getContentType, 
  decrypt,
  VARIANT_CATALOG 
} from './index.js';

describe('HLS Transcoder Utility Functions', () => {
  
  describe('toSecretKey', () => {
    it('should format callback client id correctly', () => {
      expect(toSecretKey('stagapps-sandbox')).toBe('HLS_CALLBACK_SECRET_STAGAPPS_SANDBOX');
      expect(toSecretKey('my-client!@#')).toBe('HLS_CALLBACK_SECRET_MY_CLIENT___');
    });
  });

  describe('resolveCallbackSecret', () => {
    it('should return default secret if no client id is provided', () => {
      const env = { HLS_CALLBACK_SECRET: 'default-secret' };
      expect(resolveCallbackSecret(undefined, env)).toBe('default-secret');
    });

    it('should return specific client secret if client id is provided', () => {
      const env = { HLS_CALLBACK_SECRET_STAGAPPS_SANDBOX: 'sandbox-secret' };
      expect(resolveCallbackSecret('stagapps-sandbox', env)).toBe('sandbox-secret');
    });

    it('should throw error if secret is missing', () => {
      const env = {};
      expect(() => resolveCallbackSecret(undefined, env)).toThrow('Missing HLS_CALLBACK_SECRET');
      expect(() => resolveCallbackSecret('missing-client', env)).toThrow('Missing callback secret env');
    });
  });

  describe('buildMasterPlaylist', () => {
    it('should generate a valid m3u8 master playlist', () => {
      const variants = [VARIANT_CATALOG[0], VARIANT_CATALOG[1]]; // 480p, 720p
      const playlist = buildMasterPlaylist(variants);
      
      expect(playlist).toContain('#EXTM3U');
      expect(playlist).toContain('#EXT-X-VERSION:3');
      expect(playlist).toContain('NAME="480p"');
      expect(playlist).toContain('480p.m3u8');
      expect(playlist).toContain('NAME="720p"');
      expect(playlist).toContain('720p.m3u8');
    });
  });

  describe('getContentType', () => {
    it('should return correct content types for HLS files', () => {
      expect(getContentType('video.m3u8')).toBe('application/vnd.apple.mpegurl');
      expect(getContentType('segment_000.ts')).toBe('video/mp2t');
      expect(getContentType('image.jpg')).toBe('application/octet-stream');
    });
  });

  describe('decrypt', () => {
    it('should return raw value if no private key is provided', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(decrypt('some-encrypted-value', undefined)).toBe('some-encrypted-value');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('TRANSCODER_PRIVATE_KEY not set'));
      consoleSpy.mockRestore();
    });

    it('should return raw value if decryption fails', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(decrypt('invalid-base64', 'fake-private-key')).toBe('invalid-base64');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Decryption failed'));
      consoleSpy.mockRestore();
    });
  });
});
