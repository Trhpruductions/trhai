# How TRH AI uses AI

*Version 2026-11-01. In effect from 2026-11-05.*

Where the AI runs, what leaves your PC, what the AI can get wrong, and which parts are still early.

## Where the AI runs

The AI that writes TRH AI's answers is a language model that runs on your own PC, in an engine that TRH AI starts and stops itself (llama.cpp). The model files are stored on your PC. Speech is made and recognised on your PC too (Piper and whisper.cpp).

What you type to the assistant, the files it reads and the answers it writes are not sent to TRH Development or to any AI company's service. There is no account with an AI provider and no key for one.

> **In short:** The one thing that is not local is what you ask it to fetch from the internet. The list below is every case.

## What can leave your PC when you use the assistant

- **A web search**, when you ask TRH AI to search the web. The words searched are sent to DuckDuckGo, which sees them and your internet address.
- **Reading a web page**, when you ask it to read one. The address you gave is requested from that site, which sees your internet address.
- **An email or a text link**, when you ask it to send one. An email goes through the account you connected, to your email provider's server. A text opens Windows Phone Link; nothing is sent by TRH AI.
- **Opening a website or a music service**, when you ask. Your browser opens the page; TRH AI cannot press play or sign in for you.
- **Downloads you start**: the engine, models, voices and tools come from GitHub, Hugging Face and similar sites. They are requests for a file; no conversation goes with them.

The [Privacy Policy](privacy.md) and [Services TRH AI can contact](services.md) give the details, including the background check for updates.

## What the AI can get wrong

A language model predicts likely words. It does not look facts up, and it cannot tell when it is wrong. Expect it to:

- state something false with confidence, or invent names, numbers, quotations and links;
- be out of date: a model knows only what it was trained on, up to a date well before today;
- misread a file or a question, or leave something out, and answer differently when asked twice;
- write code or commands that do not work, or that do more than you meant;
- be weaker on a small model or a slow PC. Which models are installed, and how large they are, changes how good the answers are.

TRH AI is built to say so when something it tried did not work, and not to claim work that did not happen. That makes mistakes easier to catch. It does not make the AI right. Check what matters.

## It is not advice

Nothing the AI says is medical, legal, financial, tax, safety or other professional advice, and it is no substitute for a qualified person who knows your situation. Do not delay getting help, or act against advice you have been given, because of something it said.

## When it acts for you

The assistant can do things as well as say them: make and edit files, build small apps, set schedules and reminders, make documents, spreadsheets, presentations and videos, and run commands. These changes are real.

- **Machine access is on by default in this version.** While it is on, the assistant can read and write files anywhere your Windows account can, and run commands as you, when you ask it to. While it is off, it works only inside its own **workspace folder** and cannot run commands. Switch it off or on at any time in **Tools**; the Code screen shows every command it has run.
- Because it reads text from files, documents and web pages, text in any of them can try to steer it. Keep machine access off when you are working with material you do not trust.
- Work that runs while you are away, such as a schedule, never runs commands and stays inside the workspace folder.
- Other devices on your network cannot reach TRH AI unless you turn on network access, and then each needs the access key shown in the app.
- A change you did not mean to ask for can still happen. Keep copies of files you cannot afford to lose.

> **For legal review:** Machine access is on by default in the code today, although docs/15 and docs/25 said it was off. Whether it should start off is a decision for the owner (it affects every new user); this text says what the code does. If the default changes, change this section with it.

## Parts that are still early

TRH AI is early software: its version numbers begin with 0, and it has been used on few PCs. Treat every feature as early. Some are earlier than others:

- **Hands-free voice.** Speech recognition and speech were tried end to end with recorded speech made on the same PC. Real microphones, speakers and background noise in real rooms have had little testing.
- **Documents it makes** (Word, Excel and PowerPoint files). They are written by TRH AI itself and read back to check them, and were checked with open-source readers. They have not been opened in Microsoft Office. Open one and look before you send it.
- **Video and music-video making.** Slow on a PC without a graphics card, and the result depends on the PC's video tools.

> **For legal review:** This list is taken from the project's own notes as they stood on 2026-11-01. The owner should confirm it, and add or remove features, before release.

## Models and voices have their own licenses

The models and voices TRH AI can run are made by other companies and communities. Some may be used for any purpose; some only for non-commercial use; a few have no stated license. **Settings, Engine and models** shows the license of each. You are responsible for using a model or voice within its license, especially if you use TRH AI for work.

## What stays your responsibility

- What you ask the AI to do, and whether you have the right to do it.
- Checking its work before you use, publish or rely on it, and saying so where the law or a rule requires you to say something was made with AI.
- Not putting into it information you are not allowed to share, including other people's private information. It stays on your PC, but anyone who uses your PC or account can read it.

Report a mistake or a concern to **[TO BE SUPPLIED: support email address]**.
