import type { InterfaceLanguage } from './language'

/**
 * The first message in a new account's Dr. Dou chat. It is fixed product copy,
 * so it works before any model connects, and every client writes it under the
 * same id: a desktop and the web app greeting at once leave one message.
 */
export function systemAdminWelcome(name: string, language: InterfaceLanguage): string {
  // The chat list shows the built-in name localized; the greeting says the same.
  if (language === 'zh-CN' && name === 'Dr. Dou') name = '豆博士'
  return language === 'zh-CN'
    ? `你好，我是${name}，欢迎来到 Douchat！你可以直接通过聊天，让我帮你：

- **创建联系人**：试着说“帮我创建一个英语老师”，告诉我你需要怎样的智能体。
- **拉群协作**：有了联系人后，说“把英语老师和你拉进一个学习群”。在群里也可以用 @ 指定谁来回答。
- **解决日常问题**：写邮件、翻译、解释代码、制定学习计划，或者一起梳理一个想法。
- **设置提醒**：比如“10 分钟后提醒我喝水”（Douchat 需要保持运行）。

不知道从哪里开始？告诉我你想完成什么，我们一起试试。`
    : `Hi, I'm ${name}. Welcome to Douchat! Just tell me what you need:

- **Create a contact**: Try “Create an English tutor for me” and describe the agent you want.
- **Start a group**: Once you have a contact, say “Put you and my English tutor in a study group.” Use @ in the group to choose who answers.
- **Get everyday help**: Draft emails, translate text, explain code, make a study plan, or think through an idea.
- **Set a reminder**: Try “Remind me to drink water in 10 minutes” (keep Douchat running).

Not sure where to start? Tell me what you'd like to accomplish, and we'll try it together.`
}

/** One greeting per chat topic, whichever client writes it. */
export const greetingMessageId = (conversationId: string, topicId: string): string => `greeting:${conversationId}:${topicId}`
