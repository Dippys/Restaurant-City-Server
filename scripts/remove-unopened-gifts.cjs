#!/usr/bin/env node
'use strict';

function parseArgs(argv) {
  const options = { apply: false, networkUid: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--network-uid') options.networkUid = String(argv[++index] ?? '').trim();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('Usage: npm run repair:unopened-gifts -- --network-uid UID [--apply]');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run repair:unopened-gifts -- --network-uid UID [--apply]\n\nPreview-only unless --apply is supplied. Stop the server before applying.');
    return;
  }
  if (!/^\d+$/.test(options.networkUid)) throw new Error('--network-uid must be a numeric Restaurant City network UID.');

  const { prisma } = require('../dist/db/client.js');
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { networkUid: options.networkUid },
      select: { id: true, networkUid: true, fullName: true },
    });
    if (!profile) throw new Error(`No user profile exists for network UID ${options.networkUid}.`);

    const where = { recipientProfileId: profile.id, type: 4, read: false, deleted: false };
    const [count, senders] = await Promise.all([
      prisma.mail.count({ where }),
      prisma.mail.groupBy({
        by: ['senderNetworkUid'],
        where,
        _count: { _all: true },
        orderBy: { _count: { senderNetworkUid: 'desc' } },
        take: 10,
      }),
    ]);

    console.log(`Recipient: ${profile.fullName} (${profile.networkUid})`);
    console.log(`Unopened visible gifts: ${count}`);
    for (const sender of senders) console.log(`  sender ${sender.senderNetworkUid}: ${sender._count._all}`);

    if (!options.apply) {
      console.log('Read-only: nothing changed. Re-run with --apply after stopping the server.');
      return;
    }

    const result = await prisma.mail.updateMany({ where, data: { deleted: true } });
    console.log(`Removed ${result.count} unopened gifts from ${profile.networkUid}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { parseArgs };
