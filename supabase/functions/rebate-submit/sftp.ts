// SFTP submission + credential retrieval. The password / private key lives in
// Supabase Vault; we read it via a service-role SECURITY DEFINER RPC
// (rebate_get_secret) so the secret never sits in a normal table or on a client.
//
// deno-lint-ignore-file no-explicit-any

export interface SftpCred {
  host: string;
  port: number;
  user: string;
  remoteDir: string;
  secret: string | null; // password OR private key (PEM)
}

export async function fetchCredential(admin: any, tenantId: string, mfrUid: string): Promise<SftpCred | null> {
  const { data } = await admin
    .from('manufacturer_credentials')
    .select('sftp_host, sftp_port, sftp_user, vault_secret_id, remote_dir')
    .eq('tenant_id', tenantId)
    .eq('manufacturer_uid', mfrUid)
    .maybeSingle();
  if (!data || !data.sftp_host) return null;

  let secret: string | null = null;
  if (data.vault_secret_id) {
    const { data: s } = await admin.rpc('rebate_get_secret', { p_id: data.vault_secret_id });
    secret = (s as string) ?? null;
  }
  return {
    host: data.sftp_host,
    port: Number(data.sftp_port) || 22,
    user: data.sftp_user,
    remoteDir: data.remote_dir || '.',
    secret,
  };
}

/** Upload file contents to the manufacturer's SFTP server. Returns the remote path. */
export async function sftpUpload(cred: SftpCred, filename: string, contents: string): Promise<string> {
  // Mature SFTP client via npm specifier (supported in Supabase Edge Functions).
  const mod: any = await import('npm:ssh2-sftp-client@10');
  const SftpClient = mod.default || mod;
  const sftp = new SftpClient();

  const isKey = !!cred.secret && cred.secret.includes('-----BEGIN');
  const connectOpts: Record<string, unknown> = { host: cred.host, port: cred.port, username: cred.user };
  if (isKey) connectOpts.privateKey = cred.secret;
  else connectOpts.password = cred.secret;

  await sftp.connect(connectOpts);
  try {
    const remote = cred.remoteDir.replace(/\/+$/, '') + '/' + filename;
    // deno-lint-ignore no-node-globals
    await sftp.put(Buffer.from(contents, 'utf8'), remote);
    return remote;
  } finally {
    try { await sftp.end(); } catch { /* ignore */ }
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
