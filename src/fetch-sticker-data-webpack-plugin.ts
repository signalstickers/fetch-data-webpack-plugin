import path from 'path';

import findUp from 'find-up';
import fs from 'fs-extra';
import yaml from 'js-yaml';
import pQueue from 'p-queue';
import pRetry from 'p-retry';
import ProgressBar from 'progress';
import * as R from 'ramda';
import webpack from 'webpack';

import {getStickerPackManifest} from '@signalstickers/stickers-client';
import {StickerPackPartial, StickerPackYaml} from 'etc/types';


// ----- Locals ----------------------------------------------------------------

/**
 * Limits concurrency of requests made to the Signal API to avoid throttling.
 */
const requestQueue = new pQueue({ concurrency: 6 });


/**
 * Queries Signal for each sticker pack enumerated in stickers.yml and creates
 * a StickerPackPartial. This object is then cached on disk to improve
 * performance.
 */
async function getAllStickerPacks(inputFile: string): Promise<Array<StickerPackPartial>> {
  let cacheHits = 0;
  let cacheMisses = 0;

  const stickerPackPartials: Array<StickerPackPartial> = [];
  const stickerPackYaml = yaml.load(await fs.readFile(inputFile, { encoding: 'utf8' })) as StickerPackYaml;
  const stickerPackEntries = Object.entries(stickerPackYaml);

  const gitRoot = await findUp('.git', { type: 'directory', cwd: __dirname });

  if (!gitRoot) {
    throw new Error('Not in a git repository.');
  }

  const cacheDir = path.resolve(gitRoot, '..', '.sticker-pack-cache');

  // Create the cache directory if it does not exist.
  await fs.ensureDir(cacheDir);

  console.log('[FetchStickerDataPlugin] Downloading sticker pack manifests.');

  const bar = new ProgressBar('[FetchStickerDataPlugin] [:bar] :current / :total', {
    total: stickerPackEntries.length,
    width: 64,
    clear: true,
    head: '>'
  });

  // Map over our list of entries from the input file and for each entry, add an
  // async "task function" to our queue (used to limit concurrency). Each task
  // function utilizes pRetry so that we can recover from transient network
  // errors and/or throttling from the Signal API.
  await requestQueue.addAll(R.map(([id, meta]) => async () => pRetry(async () => {
    const cachePath = path.resolve(cacheDir, `${id}.json`);
    const cacheHasPack = await fs.pathExists(cachePath);
    let stickerPackPartial: StickerPackPartial;

    if (cacheHasPack) {
      stickerPackPartial = await fs.readJson(cachePath);
      cacheHits++;
    } else {
      const stickerPackManifest = await getStickerPackManifest(id, meta.key);

      stickerPackPartial = {
        meta: {...meta, id},
        // To keep the size of the generated JSON file small, only extract
        // the properties from the manifest that we need to generate a list
        // of search results.
        manifest: R.pick(['title', 'author', 'cover'], stickerPackManifest)
      };

      await fs.writeJson(cachePath, stickerPackPartial);
      cacheMisses++;
    }

    // Order partials in the reverse order of stickers.yml, so the most
    // recently added pack is first (assuming stickers.yml is only ever
    // appended to when new packs are added).
    stickerPackPartials.unshift(stickerPackPartial);
    bar.tick();
  }, { retries: 2 }), stickerPackEntries));

  const cacheHitRate = Math.round(cacheHits / (cacheHits + cacheMisses) * 100);
  const cacheMissRate = Math.round(cacheMisses / (cacheHits + cacheMisses) * 100);

  console.log('[FetchStickerDataPlugin] Done.\n');
  console.log(`[FetchStickerDataPlugin] Cache hits: ${cacheHits} (${cacheHitRate}%). Cache misses: ${cacheMisses} (${cacheMissRate}%).`);

  return stickerPackPartials;
}


/**
 * Options accepted by FetchStickerDataPlugin.
 */
export interface FetchStickerDataPluginOptions {
  inputFile: string;
  outputFile: string;
}


export default class FetchStickerDataPlugin {
  /**
   * Name of the input file, which should be a YAML document consisting of an
   * array of StickerPackMetadata objects.
   */
  inputFile: string;

  /**
   * Name of the output file, which will be a JSON document containing an array
   * of StickerPackPartial objects.
   */
  outputFile: string;


  constructor({inputFile, outputFile}: FetchStickerDataPluginOptions) {
    this.inputFile = inputFile;
    this.outputFile = outputFile;
  }


  apply(compiler: webpack.Compiler) {
    compiler.hooks.emit.tapPromise('FetchStickerDataPlugin', async compilation => {
      const json = JSON.stringify(await getAllStickerPacks(this.inputFile));

      compilation.assets[this.outputFile] = {
        source: () => json,
        size: () => json.length
      };
    });
  }
}
