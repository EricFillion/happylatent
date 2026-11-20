import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const REVIEW_LIFETIME_MS = 10 * 60_000;
const token = () => randomBytes(24).toString('base64url');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export class ModelReviewPending extends Error {
  constructor(url, expiresAt) {
    super('Open the local review link in your browser. After you approve, retry this tool with the same arguments.');
    this.result = {
      status: 'awaiting_approval', approvalUrl: url, approvalExpiresAt: new Date(expiresAt).toISOString(),
      next: this.message,
    };
  }
}

function page(title, content) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Happy Latent</title>
<style>
  :root { color-scheme: light dark; font: 16px/1.55 system-ui, sans-serif; }
  body { max-width: 52rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { line-height: 1.2; }
  pre { font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; padding: 1rem; border: 1px solid GrayText; border-radius: .5rem; }
  form { display: inline-block; margin: .25rem .5rem .25rem 0; }
  button { font: inherit; padding: .5rem 1rem; cursor: pointer; }
</style></head><body><main><h1>${title}</h1>${content}</main></body></html>`;
}

function respond(response, status, title, content = '') {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(page(title, content));
}

export class ModelReviews {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.reviews = new Map();
    this.links = new Map();
    this.closed = false;
  }

  async request(key, { digest, message, signal, expiresAt = Infinity, uploadChoices, actionTitle }) {
    const subject = uploadChoices ? 'Runpod upload' : actionTitle ? 'Runpod action' : 'Model';
    if (this.closed || signal?.aborted) throw new Error(`${subject} approval was cancelled.`);
    const origin = await (this.listener ??= this.listen());
    if (this.closed || signal?.aborted) throw new Error(`${subject} approval was cancelled.`);
    const now = this.now();
    for (const [id, review] of this.reviews) if (review.expiresAt <= now) this.remove(id);
    let review = this.reviews.get(key);
    if (review?.digest !== digest) {
      this.remove(key);
      const deadline = Math.min(now + REVIEW_LIFETIME_MS, expiresAt);
      if (deadline <= now) throw new Error(`${subject} approval has expired. Request a fresh review.`);
      const category = uploadChoices ? 'uploads' : actionTitle ? 'actions' : 'models';
      review = { digest, message, path: `/${category}/${token()}`,
        formToken: token(), expiresAt: deadline, uploadChoices, actionTitle };
      this.reviews.set(key, review);
      this.links.set(review.path, review);
    }
    if (review.decision && (uploadChoices || actionTitle)) {
      this.remove(key);
      if (review.decision === 'decline') return { action: 'decline' };
      return { action: 'accept', ...(uploadChoices ? { content: { mode: review.decision } } : {}) };
    }
    if (review.decision === 'approve') return { action: 'accept' };
    if (review.decision === 'decline') throw new Error('Model approval was declined. Use a new requestId to review the batch again.');
    throw new ModelReviewPending(origin + review.path, review.expiresAt);
  }

  remove(key) {
    const review = this.reviews.get(key);
    if (!review) return;
    this.links.delete(review.path);
    this.reviews.delete(key);
  }

  async listen() {
    const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 },
      (request, response) => this.handle(request, response));
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      server.unref();
      this.host = `127.0.0.1:${server.address().port}`;
      return `http://${this.host}`;
    } catch (error) {
      this.listener = undefined;
      throw new Error('Could not open the local approval page.', { cause: error });
    }
  }

  handle(request, response) {
    if (this.closed || request.headers.host !== this.host) return respond(response, 403, 'Request refused');
    const [, path, formToken, decision] = request.url.match(/^(\/(?:models|uploads|actions)\/[\w-]+)(?:\/([\w-]+)\/([\w-]+))?$/) ?? [];
    const review = this.links.get(path);
    if (!review || review.expiresAt <= this.now()) {
      return respond(response, 404, 'Review unavailable', '<p>Return to the chat to request a new review.</p>');
    }
    const choices = review.uploadChoices ?? [['approve', 'Approve this plan']];
    if (request.method === 'POST') {
      if (request.headers.origin !== `http://${this.host}` || formToken !== review.formToken
          || (decision !== 'decline' && !choices.some(([value]) => value === decision))) {
        return respond(response, 403, 'Request refused');
      }
      review.decision ??= decision;
    } else if (request.method !== 'GET' || formToken) {
      return respond(response, 405, 'Request refused');
    }
    if (review.decision === 'decline') return respond(response, 200, 'Declined', '<p>You can close this page and return to the chat.</p>');
    if (review.decision) return respond(response, 200, 'Approved', '<p>Return to the chat and ask it to continue the same request.</p>');
    const formPath = `${path}/${review.formToken}`;
    const buttons = choices.map(([value, label]) =>
      `<form method="post" action="${formPath}/${value}"><button type="submit">${escape(label)}</button></form>`).join('\n');
    const title = review.actionTitle ?? (review.uploadChoices ? 'Review Runpod uploads' : 'Review model downloads');
    return respond(response, 200, title, `<pre>${escape(review.message)}</pre>
${buttons}
<form method="post" action="${formPath}/decline"><button type="submit">Decline</button></form>`);
  }

  async close() {
    this.closed = true;
    this.reviews.clear();
    this.links.clear();
    await this.listener?.catch(() => {});
    if (!this.server?.listening) return;
    const closed = new Promise(resolve => this.server.close(resolve));
    this.server.closeAllConnections();
    await closed;
  }
}
