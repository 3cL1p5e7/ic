/**
 * Implement the HttpRequest to Canisters Proposal.
 */
import { Actor, ActorSubclass, HttpAgent, QueryResponseStatus } from '@dfinity/agent';
import { IDL } from '@dfinity/candid';
import { Principal } from '@dfinity/principal';
import { validateBody } from './validation';
import * as base64Arraybuffer from 'base64-arraybuffer';
import * as pako from 'pako';

const hostnameCanisterIdMap: Record<string, [string, string]> = {
  'identity.ic0.app': ['rdmx6-jaaaa-aaaaa-aaadq-cai', 'ic0.app'],
  'nns.ic0.app': ['qoctq-giaaa-aaaaa-aaaea-cai', 'ic0.app'],
  'dscvr.ic0.app': ['h5aet-waaaa-aaaab-qaamq-cai', 'ic0.page'],
  'personhood.ic0.app': ['g3wsl-eqaaa-aaaan-aaaaa-cai', 'ic0.app'],
};

const shouldFetchRootKey: boolean = !!process.env.FORCE_FETCH_ROOT_KEY || false;

const swLocation = new URL(self.location.toString());
const [_swCanisterId, swDomains] = (() => {
  const maybeSplit = splitHostnameForCanisterId(swLocation.hostname);
  if (maybeSplit) {
    return maybeSplit;
  } else {
    return [null, swLocation.hostname];
  }
})() as [Principal | null, string];

/**
 * Split a hostname up-to the first valid canister ID from the right.
 * @param hostname The hostname to analyze.
 * @returns A canister ID followed by all subdomains that are after it, or null if no
 *     canister ID were found.
 */
function splitHostnameForCanisterId(hostname: string): [Principal, string] | null {
  const maybeFixed = hostnameCanisterIdMap[hostname];
  if (maybeFixed) {
    return [Principal.fromText(maybeFixed[0]), maybeFixed[1]];
  }

  const subdomains = hostname.split('.').reverse();
  const topdomains = [];
  for (const domain of subdomains) {
    try {
      const principal = Principal.fromText(domain);
      return [principal, topdomains.reverse().join('.')];
    } catch (_) {
      topdomains.push(domain);
    }
  }

  return null;
}

/**
 * Try to resolve the Canister ID to contact in the domain name.
 * @param hostname The domain name to look up.
 * @returns A Canister ID or null if none were found.
 */
function maybeResolveCanisterIdFromHostName(hostname: string): Principal | null {
  // Try to resolve from the right to the left.
  const maybeCanisterId = splitHostnameForCanisterId(hostname);
  if (maybeCanisterId && swDomains === maybeCanisterId[1]) {
    return maybeCanisterId[0];
  }

  return null;
}

/**
 * Try to resolve the Canister ID to contact in the search params.
 * @param searchParams The URL Search params.
 * @param isLocal Whether to resolve headers as if we were running locally.
 * @returns A Canister ID or null if none were found.
 */
function maybeResolveCanisterIdFromSearchParam(
  searchParams: URLSearchParams,
  isLocal: boolean,
): Principal | null {
  // Skip this if we're not on localhost.
  if (!isLocal) {
    return null;
  }

  const maybeCanisterId = searchParams.get('canisterId');
  if (maybeCanisterId) {
    try {
      return Principal.fromText(maybeCanisterId);
    } catch (e) {
      // Do nothing.
    }
  }

  return null;
}

/**
 * Try to resolve the Canister ID to contact from a URL string.
 * @param urlString The URL in string format (normally from the request).
 * @param isLocal Whether to resolve headers as if we were running locally.
 * @returns A Canister ID or null if none were found.
 */
function resolveCanisterIdFromUrl(urlString: string, isLocal: boolean): Principal | null {
  try {
    const url = new URL(urlString);
    return (
      maybeResolveCanisterIdFromHostName(url.hostname) ||
      maybeResolveCanisterIdFromSearchParam(url.searchParams, isLocal)
    );
  } catch (_) {
    return null;
  }
}

/**
 * Try to resolve the Canister ID to contact from headers.
 * @param headers Headers from the HttpRequest.
 * @param isLocal Whether to resolve headers as if we were running locally.
 * @returns A Canister ID or null if none were found.
 */
function maybeResolveCanisterIdFromHeaders(headers: Headers, isLocal: boolean): Principal | null {
  const maybeHostHeader = headers.get('host');
  if (maybeHostHeader) {
    // Remove the port.
    const maybeCanisterId = maybeResolveCanisterIdFromHostName(
      maybeHostHeader.replace(/:\d+$/, ''),
    );
    if (maybeCanisterId) {
      return maybeCanisterId;
    }
  }

  if (isLocal) {
    const maybeRefererHeader = headers.get('referer');
    if (maybeRefererHeader) {
      const maybeCanisterId = resolveCanisterIdFromUrl(maybeRefererHeader, isLocal);
      if (maybeCanisterId) {
        return maybeCanisterId;
      }
    }
  }

  return null;
}

function maybeResolveCanisterIdFromHttpRequest(request: Request, isLocal: boolean) {
  return (
    (isLocal && resolveCanisterIdFromUrl(request.referrer, isLocal)) ||
    maybeResolveCanisterIdFromHeaders(request.headers, isLocal) ||
    resolveCanisterIdFromUrl(request.url, isLocal)
  );
}

const StreamingCallbackToken = IDL.Record({
  key: IDL.Text,
  sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
  index: IDL.Nat,
  content_encoding: IDL.Text,
});
const StreamingCallbackHttpResponse = IDL.Record({
  token: IDL.Opt(StreamingCallbackToken),
  body: IDL.Vec(IDL.Nat8),
});
const canisterIdlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const HeaderField = IDL.Tuple(IDL.Text, IDL.Text);
  const StreamingStrategy = IDL.Variant({
    Callback: IDL.Record({
      token: StreamingCallbackToken,
      callback: IDL.Func(
        [StreamingCallbackToken],
        [IDL.Opt(StreamingCallbackHttpResponse)],
        ["query"]
      ),
    }),
  });
  const HttpRequest = IDL.Record({
    method: IDL.Text,
    url: IDL.Text,
    headers: IDL.Vec(HeaderField),
    body: IDL.Vec(IDL.Nat8),
  });
  const HttpResponse = IDL.Record({
    status_code: IDL.Nat16,
    headers: IDL.Vec(HeaderField),
    body: IDL.Vec(IDL.Nat8),
    streaming_strategy: IDL.Opt(StreamingStrategy),
  });

  return IDL.Service({
    http_request: IDL.Func([HttpRequest], [HttpResponse], ['query']),

    // TODO PR#1 remove after pr
    get: IDL.Func(
      [IDL.Record({ key: IDL.Text, accept_encodings: IDL.Vec(IDL.Text) })],
      [
        IDL.Record({
          content: IDL.Vec(IDL.Nat8),
          sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
          content_type: IDL.Text,
          content_encoding: IDL.Text,
          total_length: IDL.Nat,
        }),
      ],
      ['query'],
    ),
  });
};

/**
 * Decode a body (ie. deflate or gunzip it) based on its content-encoding.
 * @param body The body to decode.
 * @param encoding Its content-encoding associated header.
 */
function decodeBody(body: Uint8Array, encoding: string): Uint8Array {
  switch (encoding) {
    case 'identity':
    case '':
      return body;
    case 'gzip':
      return pako.ungzip(body);
    case 'deflate':
      return pako.inflate(body);
    default:
      throw new Error(`Unsupported encoding: "${encoding}"`);
  }
}

// TODO remove after PR#2-3
let chunkInfoCache: Record<string, Record<number, number>> = {};

interface FetchRangePayload {
  url: URL;
  canisterId: Principal;
  actor: ActorSubclass;
  agent: HttpAgent;
  request: Request;
}

export const getSteamingChunksResponse = async (p: FetchRangePayload): Promise<Response> => {
  console.log('Request ' + p.url.pathname, p.request?.headers?.get('Range'));
  const res = await _getSteamingChunksResponse(p);
  console.log('Response ' + p.url.pathname, { status: res.status, headers: res.headers.get('Content-Range') });
  return res;
};

const _getSteamingChunksResponse = async ({
	url, actor, agent, request, canisterId
}: FetchRangePayload): Promise<Response> => {
  console.log('Oookey lets go');
  const src = url.pathname;
  
  const headers: [string, string][] = [];
  // FIXME bad practice
  (request.headers || new Headers()).forEach((value, key) => {
    headers.push([key, value]);
  });

  const httpRequest = {
    method: request.method || 'GET',
    url: url.pathname + url.search,
    headers,
    body: request.arrayBuffer ? [...new Uint8Array(await request.arrayBuffer())] : [],
  };

	const response: any = await actor.http_request(httpRequest);

	const firstChunk = new Uint8Array(response.body);
	const rangeHeader = headers.find(([key]) => key.toLowerCase() == 'range');

	if (!rangeHeader) {
		const data = await fetchBody(canisterId, agent, response);

    return new Response(data, { status: response.status_code, headers: [
      ...response.headers,
			['Content-Length', `${data.length}`]
		] });
	}

  // TODO PR#1 add to certified_assets PR for adding total length into content-length header or `total_length` to HttpResponse object
  // OR live without size
	// const contentLengthHeader = response.headers.find(([key]) => key.toLowerCase() == 'content-length');
  // const size = contentLengthHeader ? Number(contentLengthHeader[1]) : 0;
  const keyForGet = url.pathname == '/' ? '/index.html' : url.pathname;
  const { total_length }: any = await actor.get({ key: keyForGet, accept_encodings: ['identity'] });
  const size = Number(total_length);

  // FIXME remove after PR#2-3
  if (!chunkInfoCache[src]) {
    chunkInfoCache[src] = {
      0: firstChunk.length,
    };
  }
  // FIXME remove after PR#2-3
  const cachedSize = Object.values(chunkInfoCache[src]).reduce((acc, next) => acc + next, 0);
  if (cachedSize !== size) {
    console.log('!!! FIXME PR#2 and 3 lets cache');
    await fetchBody(canisterId, agent, response, ({data, index}) => {
      chunkInfoCache[src][index] = data.length;
    });
  }

  // FIXME bad practice
  const start = Number(rangeHeader[1].split('bytes=')[1].split('-')[0]);
  const callback = getCallbackToken(response);

  if (!callback || !chunkInfoCache[src]) {
    return new Response(firstChunk, { status: 206, headers: [
      ...response.headers,
      ['Content-Range', `bytes 0-${firstChunk.length}/${firstChunk.length + 1}`]
    ]});
  }

  const { token, methodName } = callback;

  let reduced = 0;
  const entry = Object.entries(chunkInfoCache[src]).find(entry => {
    reduced += entry[1];

    return start < reduced;
  });

  if (!entry) {
    console.log('Return no entry', { start });
    return new Response(null, { status: 216, headers: response.headers });
  }

  console.log('Current entry', entry);
  if (entry[0] == '0') {
    // FIXME DRY
    return new Response(firstChunk, { status: 206, headers: [
      ...response.headers,
      ['Content-Range', `bytes 0-${firstChunk.length}/${size + 1}`]
    ]});
  }

  const encodedResponse = await agent.query(canisterId, {
    methodName,
    arg: IDL.encode([StreamingCallbackToken], [{
      ...token,
      index: BigInt(entry[0])
    }]),
  });

  if (encodedResponse.status != 'rejected') {
    const decoded = IDL.decode(
      [StreamingCallbackHttpResponse],
      encodedResponse.reply.arg
    );
  
    const decodedResponse = decoded[0] as any;
  
    const bytes: number[] = decodedResponse?.body || [];
  
    return new Response(new Uint8Array(bytes), { status: 206, headers: [
      ...response.headers,
      ['Content-Range', `bytes ${reduced - entry[1]}-${reduced}/${size + 1}`]
    ] });
  }

  const statusText = `${encodedResponse.reject_code}: ${encodedResponse.reject_message}`;
  console.error(statusText);
  return new Response(null, { status: 216, statusText, headers: response.headers });

  // TODO PR#2 HttpResponse.streaming_strategy need to return all chunks tokens for build manual download strategy
  // TODO PR#3 - need to know the size (bytes length) of any chunk from token
  // all 3 TODOs might be resolved as:
  // add `chunks` and `total_length` fields to HttpResponse object
  // HttpResponse.chunks: { [key: bigint]: number }, where is { index: content_length }
  // HttpResponse.total_length: number
};

/**
 * Fetch and merge body chunks
 * @param canisterId Canister which contains chunks
 * @param agent Existing HttpAgent
 * @param httpResponse HttpResponse idl. Result of http_request query call
 */
 export async function fetchBody(
  canisterId: Principal,
  agent: HttpAgent,
  httpResponse: any,
  onChunkDownloaded: ({data: Uint8Array, index: number, done: boolean}) => void = () => {},
): Promise<Uint8Array> {
  let body = new Uint8Array(httpResponse.body);

  const callback = getCallbackToken(httpResponse);
  if (!callback) {
    return body;
  }

  let token = callback.token;
  const methodName = callback.methodName;

  while (!!token) {
    try {
      const encodedResponse = await agent.query(canisterId, {
        methodName,
        arg: IDL.encode([StreamingCallbackToken], [token]),
      });

      if (encodedResponse.status == QueryResponseStatus.Rejected) {
        throw `${encodedResponse.reject_code}: ${encodedResponse.reject_message}`;
      }

      const [decodedResponse]: any = IDL.decode(
        [StreamingCallbackHttpResponse],
        encodedResponse.reply.arg
      );

      const bytes: number[] = decodedResponse?.body || [];
      const nextToken = decodedResponse.token ? decodedResponse.token[0] : undefined;

      onChunkDownloaded({data: new Uint8Array(bytes), index: Number(token?.index), done: !token});

      const mergedBody = new Uint8Array(body.length + bytes.length);
      mergedBody.set(body);
      mergedBody.set(bytes, body.length);
      body = mergedBody;
      token = nextToken;

    } catch (e) {
      body = new Uint8Array(httpResponse.body);
      break;
    }
  }

  return body;
}

const getCallbackToken = (response: any) => {
  if (!('streaming_strategy' in response)) {
    return null;
  }

  const strategy = response.streaming_strategy[0];
  if (!strategy) {
    return null;
  }

  const [_, methodName] = strategy.Callback.callback;

  const token = strategy.Callback.token;

  if (!token) {
    return null;
  }

  return { methodName, token };
};

/**
 * Box a request, send it to the canister, and handle its response, creating a Response
 * object.
 * @param request The request received from the browser.
 * @returns The response to send to the browser.
 * @throws If an internal error happens.
 */
export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  /**
   * We forward all requests to /api/ to the replica, as is.
   */
  if (url.pathname.startsWith('/api/')) {
    let response = await fetch(request);
    // force the content-type to be cbor as /api/ is exclusively used for canister calls
    let sanitizedHeaders = new Headers(response.headers);
    sanitizedHeaders.set('X-Content-Type-Options', 'nosniff');
    sanitizedHeaders.set('Content-Type', 'application/cbor');
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers: sanitizedHeaders});
  }

  /**
   * We refuse any request to /_/*
   */
  if (url.pathname.startsWith('/_/')) {
    return new Response(null, { status: 404 });
  }

  /**
   * We try to do an HTTP Request query.
   */
  const isLocal = swDomains === 'localhost';
  const maybeCanisterId = maybeResolveCanisterIdFromHttpRequest(request, isLocal);
  if (maybeCanisterId) {
    try {
      const replicaUrl = new URL(url.origin);
      const agent = new HttpAgent({
        host: replicaUrl.toString(),
        fetch: self.fetch.bind(self),
      });
      const actor = Actor.createActor(canisterIdlFactory, {
        agent,
        canisterId: maybeCanisterId,
      });
      const requestHeaders: [string, string][] = [];
      request.headers.forEach((value, key) => requestHeaders.push([key, value]));

      // If the accept encoding isn't given, add it because we want to save bandwidth.
      if (!request.headers.has('Accept-Encoding')) {
        requestHeaders.push(['Accept-Encoding', 'gzip, deflate, identity']);
      }

      const httpResponse = await getSteamingChunksResponse({
        url,
        actor,
        agent,
        request,
        canisterId: maybeCanisterId
      });
      
      // const httpResponse: any = await actor.http_request(httpRequest);
      const headers = new Headers();

      let certificate: ArrayBuffer | undefined;
      let tree: ArrayBuffer | undefined;
      let encoding = '';

      httpResponse.headers.forEach((value, key) => {
        switch (key.trim().toLowerCase()) {
          case 'ic-certificate':
            {
              const fields = value.split(/,/);
              for (const f of fields) {
                const [_0, name, b64Value] = [...f.match(/^(.*)=:(.*):$/)].map(x => x.trim());
                const value = base64Arraybuffer.decode(b64Value);
  
                if (name === 'certificate') {
                  certificate = value;
                } else if (name === 'tree') {
                  tree = value;
                }
              }
            }
            return;
          case 'content-encoding':
            encoding = value.trim();
            break;
        }
  
        headers.append(key, value);
      });

      const body = new Uint8Array(await httpResponse.arrayBuffer());

      const identity = decodeBody(body, encoding);

      let bodyValid = false;
      if (certificate && tree) {
        // Try to validate the body as is.
        bodyValid = await validateBody(
          maybeCanisterId,
          url.pathname,
          body.buffer,
          certificate,
          tree,
          agent,
          shouldFetchRootKey,
        );

        if (!bodyValid) {
          // If that didn't work, try to validate its identity version. This is for
          // backward compatibility.
          bodyValid = await validateBody(
            maybeCanisterId,
            url.pathname,
            identity.buffer,
            certificate,
            tree,
            agent,
            isLocal,
          );
        }
      }
      if (bodyValid) {
        return new Response(identity.buffer, {
          status: httpResponse.status,
          headers,
        });
      } else {
        console.error('BODY DOES NOT PASS VERIFICATION');
        return new Response('Body does not pass verification', { status: 500 });
      }
    } catch (e) {
      console.error('Failed to fetch response:', e);
      return new Response(`Failed to fetch response: ${String(e)}`, {
        status: 500,
      });
    }
  }

  // Last check. IF this is not part of the same domain, then we simply let it load as is.
  // The same domain will always load using our service worker, and not the same domain
  // would load by reference. If you want security for your users at that point you
  // should use SRI to make sure the resource matches.
  if (!url.hostname.endsWith(swDomains)|| url.hostname.endsWith(`raw.${swDomains}`)) {
    console.log("Direct call ...");
    // todo: Do we need to check for headers and certify the content here?
    return await fetch(request);
  }

  console.error(`URL ${JSON.stringify(url.toString())} did not resolve to a canister ID.`);
  return new Response('Could not find the canister ID.', { status: 404 });
}
