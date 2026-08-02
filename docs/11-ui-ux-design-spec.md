# TRH AI / Ascend AI
## Complete UI/UX Design Specification

Date: 2026-08-01
Status: Implementation-aligned spec

## 1. Product Experience Goal
Ascend AI must feel like an AI Operating System, not a chatbot. The interface should project high capability while remaining practical for daily work.

Target perception:
- Powerful
- Fast
- Premium
- Alive
- Trustworthy

## 2. Core Design Principles
- Functional first, futuristic second.
- Clarity before decoration.
- Always-on system awareness.
- Visual depth without visual noise.
- Motion that explains state changes.

## 3. Visual System
### Theme Mode
- Dark mode only.

### Color Palette
- Deep Space Black: #05070D
- Midnight Blue: #081A2E
- Electric Blue: #00BFFF
- Cyan: #00E5FF
- Purple Accent: #7A5CFF
- Success Green: #18C67A
- Warning Orange: #FF9C3A
- Critical Red: #FF4D6D

### Surfaces
- Frosted glass layers with soft blur.
- Thin glowing borders around active modules.
- Elevated card stacks with layered shadows.

### Shape Language
- Rounded corners, 14-22 px scale.
- Floating panels with composited depth.
- No flat full-bleed boxes for primary interactions.

## 4. Layout Architecture
- Top command strip: universal command, workspace switcher, alerts, profile.
- Left rail: subsystem navigation.
- Center stage: AI Core + contextual dashboards + chat.
- Right rail: live execution, agents, tasks, health.

Grid intent:
- Desktop: three-pane command center.
- Tablet: right rail collapses into stacked cards.
- Mobile: top-first content flow with persistent command access.

## 5. AI Core Behavior
The AI Core is the visual heartbeat of the system.

States:
- Idle: gentle pulse and low-energy orbit.
- Listening: increased ring luminance and frequency.
- Thinking: rotating gradients and node shimmer.
- Speaking: rhythmic wave expansion.

Inputs affecting the core:
- Voice activity
- Typing activity
- System processing load
- Agent execution events

## 6. Motion System
Performance target:
- 60 FPS for all primary interactions.

Motion patterns:
- Command panel reveal: short upward fade.
- Side rail transitions: 160-220 ms spring-like movement.
- Chat streaming: progressive content fade-in.
- Status updates: soft glow pulse instead of abrupt flash.

Motion constraints:
- No blocking transitions on navigation.
- Reduced motion mode must remain usable.

## 7. Home Dashboard Modules
Required modules:
- Greeting and contextual summary
- AI Core status
- Running agents overview
- Recent conversations
- Recent projects
- System insight cards (CPU/GPU/Memory/Cloud)
- Optional weather and calendar widgets

## 8. Chat Experience Requirements
- Multi-tab chat sessions
- Markdown + code + tables
- Attachments with drag and drop
- Streamed responses
- Timeline and search
- Pinned and foldered conversations
- Agent mention support

System feedback requirements:
- Typing and thinking indicators
- Tool execution traces
- Error states with direct recovery actions

## 9. Universal Command Bar
Command bar responsibilities:
- Interpret intent quickly
- Route to correct subsystem
- Show action previews before execution
- Support slash commands and natural language

Examples:
- Build a React landing page.
- Generate game quest logic.
- Draft legal contract template.
- Fix failing TypeScript build.

## 10. Workspace Model
Each workspace must isolate:
- Memory context
- Files and artifacts
- Agents
- Integrations
- Notifications and tasks

Workspace examples:
- Company Ops
- Game Studio
- Creator Lab
- Research
- Personal

## 11. Agent UX Standards
Each agent card displays:
- Avatar and name
- Role
- Current objective
- Health/status
- Permission scope
- Last run result

Collaboration signals:
- Which agents are coordinating
- What handoff is in progress
- Estimated completion time

## 12. Studio Module UX Baseline
- Code Studio: IDE + terminal + git + debugger + pair AI.
- Image Studio: generation, upscaling, brand kits.
- Video Studio: shorts, trailer workflows, captions.
- Music Studio: generation, mastering, stem tools.
- Voice Studio: voice clone, cleanup, narration.
- Game Studio: Unity/Unreal/Godot workflows.
- Website Builder: block and code hybrid mode.
- Automation Builder: node-based trigger-condition-action flows.

## 13. Notification and Activity Model
Notifications must include:
- What completed
- What changed
- What is required next
- One-click action path

Priority tiers:
- Info
- Success
- Warning
- Critical

## 14. Performance Targets
- Cold launch under 3 seconds.
- Primary navigation under 100 ms.
- Command search under 50 ms perceived latency.
- Chat response begins immediately with streaming.

Engineering constraints:
- Lazy-load heavy studio modules.
- Keep animation work on GPU-friendly properties.
- Use virtualization for long lists and timelines.

## 15. Voice and Personality
AI personality traits:
- Confident
- Professional
- Friendly
- Context-aware
- Concise by default, deep when needed

Voice behavior:
- Conversational pacing
- Clear turn-taking
- No repetitive robotic phrasing

## 16. Accessibility and Usability
- Full keyboard navigation
- Focus visibility on all interactive elements
- Contrast-safe glow effects
- ARIA labels for command and chat controls
- Reduced motion support

## 17. Current Implementation Mapping
Implemented in web shell:
- Top command strip
- Left subsystem rail
- Center AI Core panel
- Live chat panel with API integration
- Right activity and system status rail

Primary implementation files:
- apps/web/src/App.tsx
- apps/web/src/styles.css

## 18. Next Design Milestones
1. Add voice I/O and waveform interaction.
2. Add multi-chat tabs and conversation folders.
3. Add timeline search and artifact previews.
4. Add dynamic agent collaboration panel.
5. Add reduced motion and theme token editor.
