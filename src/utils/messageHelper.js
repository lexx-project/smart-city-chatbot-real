const { generateWAMessageFromContent, proto } = require('@whiskeysockets/baileys');

const sendListMessage = async (sock, jidOrMsg, title, text, footer, buttonTitle, sections) => {
    try {
        const isObj = typeof jidOrMsg === 'object';
        const jid = isObj ? jidOrMsg.key.remoteJid : jidOrMsg;
        const sender = isObj ? (jidOrMsg.key.participant || jidOrMsg.key.remoteJid) : jid;
        const botJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

        const bodyText = title ? `*${title}*\n\n${text}` : text;

        const msg = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    messageContextInfo: {
                        deviceListMetadata: {},
                        deviceListMetadataVersion: 2
                    },
                    interactiveMessage: proto.Message.InteractiveMessage.create({
                        contextInfo: {
                            mentionedJid: [sender], 
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterName: "Smart Public Service", 
                                newsletterJid: "120363144038483540@newsletter",
                                serverMessageId: 143 
                            },
                            businessMessageForwardInfo: { businessOwnerJid: botJid },
                        },
                        body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
                        footer: proto.Message.InteractiveMessage.Footer.create({ text: footer }),
                        header: proto.Message.InteractiveMessage.Header.create({
                            title: "", 
                            subtitle: "",
                            hasMediaAttachment: false // <--- UDAH GW MATIIN GAMBARNYA
                        }),
                        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                            buttons: [
                                {
                                    name: "single_select",
                                    buttonParamsJson: JSON.stringify({
                                        title: buttonTitle,
                                        sections: sections
                                    })
                                }
                            ],
                        })
                    })
                }
            }
        }, {});

        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
        console.log(`[LIST_SENT_SUCCESS] jid=${jid} messageId=${msg.key.id}`);

    } catch (error) {
        console.error('[LIST_ERROR]', error);
    }
}

module.exports = { sendListMessage };