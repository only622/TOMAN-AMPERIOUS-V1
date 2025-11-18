import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} from '@adiwajshing/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PREFIX = process.env.PREFIX ?? '!';
if (!process.env.TOKEN && !process.env.DUMMY) {
    // Baileys n'utilise pas de TOKEN, mais garde la validation si tu veux
    // ignorer ceci si inutile
    // console.warn('No TOKEN required for Baileys (this check is optional).');
}

// Charger commandes depuis ./commands (export default { name, execute })
const commandsDir = path.join(__dirname, 'commands');
const commands = new Map();
if (fs.existsSync(commandsDir)) {
    for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
        try {
            const mod = await import(path.join(commandsDir, file));
            const cmd = mod.default ?? mod;
            if (cmd && cmd.name && typeof cmd.execute === 'function') {
                commands.set(cmd.name, cmd);
                console.log(`Loaded command: ${cmd.name}`);
            } else {
                console.warn(`Fichier commande invalide : ${file}`);
            }
        } catch (err) {
            console.error(`Erreur en chargeant commande ${file}:`, err);
        }
    }
}

const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: true
});

// Persister les credentials
sock.ev.on('creds.update', saveCreds);

// Connexion / gestion des déconnexions
sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
        console.log('WhatsApp connecté:', sock.user?.id ?? '(unknown)');
    } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.warn('Connection fermée, code:', reason);
        if (reason === DisconnectReason.loggedOut) {
            console.error('Logged out — supprime ./auth_info et reconnecte manuellement.');
            process.exit(1);
        }
        // Baileys gère automatiquement certaines reconnexions; tu peux ajouter du retry si besoin.
    }
});

// Helper pour extraire le texte d'un message reçu
function getMessageText(m) {
    if (!m?.message) return null;
    const msg = m.message;
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    return null;
}

// Ecoute des messages entrants
sock.ev.on('messages.upsert', async (upsert) => {
    try {
        const messages = upsert.messages ?? [];
        for (const m of messages) {
            if (!m.message) continue;
            if (m.key && m.key.remoteJid === 'status@broadcast') continue; // ignorer status
            if (m.key.fromMe) continue; // ignorer messages envoyés par le bot

            const text = getMessageText(m);
            if (!text) continue;

            const prefix = PREFIX;
            if (!text.startsWith(prefix)) continue;

            const args = text.slice(prefix.length).trim().split(/\s+/);
            const name = args.shift().toLowerCase();
            const command = commands.get(name);
            if (!command) continue;

            const sender = m.key.participant ?? m.key.remoteJid;
            const isGroup = (m.key.remoteJid && m.key.remoteJid.endsWith('@g.us')) || false;

            try {
                await command.execute({
                    sock,
                    message: m,
                    args,
                    text,
                    sender,
                    isGroup
                });
            } catch (err) {
                console.error('Erreur commande:', err);
                try {
                    await sock.sendMessage(m.key.remoteJid, { text: 'Une erreur est survenue en exécutant la commande.' }, { quoted: m });
                } catch (sendErr) {
                    console.error('Impossible d\'envoyer le message d\'erreur:', sendErr);
                }
            }
        }
    } catch (e) {
        console.error('messages.upsert handler error:', e);
    }
});

// Gestion erreurs globales
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});
