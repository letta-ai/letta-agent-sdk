/**
 * Presenter Agent (Economist)
 * 
 * Picks a research topic, conducts research, and presents findings.
 * Defends their work against faculty questions.
 */

import { type LettaCodeSession } from '../../src/index.js';
import { createAgentSession, createExampleClient, resumeExampleSession } from '../create-agent-session.js';
import type { SeminarConfig } from './types.js';

// File-editing demo: pin the local backend so agent state stays consistent.
const client = createExampleClient({ backend: 'local' });

const PRESENTER_SYSTEM_PROMPT = `You are an economics researcher presenting at an academic seminar.

## Your Role
You conduct original research on economic topics and present your findings to a faculty panel. You must defend your work against challenging questions from experts in macroeconomics, microeconomics, behavioral economics, and economic history.

## Your Personality
- Confident but intellectually humble
- Open to criticism but able to defend your methodology
- Cite sources and evidence when challenged
- Admit limitations honestly

## Presentation Style
- Clear and structured
- Lead with your main finding/thesis
- Support with evidence and data
- Acknowledge limitations and areas for future research

## When Responding to Questions
- Address the question directly
- Provide evidence or reasoning
- Acknowledge valid criticisms
- Defend your methodology when appropriate
- Connect back to your main thesis

## Memory Usage
You have memory blocks that persist:
- **research-notes**: Track your research findings and sources
- **past-seminars**: Remember feedback from previous presentations
- **methodology**: Refine your research approach based on experience

Update these as you learn from faculty feedback.`;

/**
 * Create or resume the presenter agent
 */
export async function createPresenter(
  existingAgentId: string | null,
  config: SeminarConfig
): Promise<LettaCodeSession> {
  if (existingAgentId) {
    return resumeExampleSession(existingAgentId, {
      model: config.model,
      allowedTools: ['Read', 'Write'],
      permissionMode: 'unrestricted',
    }, client);
  }
  
  return createAgentSession({
    model: config.model,
    systemPrompt: PRESENTER_SYSTEM_PROMPT,
    memory: [
      {
        label: 'research-notes',
        value: `# Research Notes

## Current Research
[Will be populated during research phase]

## Key Sources
[Track reliable sources found]

## Data Points
[Important statistics and findings]
`,
        description: 'Track research findings, sources, and data',
      },
      {
        label: 'past-seminars',
        value: `# Past Seminar Feedback

## Recurring Critiques
[Track common challenges from faculty]

## Successful Defenses
[Note arguments that worked well]

## Areas to Improve
[Based on faculty feedback]
`,
        description: 'Remember feedback from previous presentations',
      },
      {
        label: 'methodology',
        value: `# Research Methodology

## Preferred Approaches
- Start with recent empirical studies
- Look for natural experiments
- Consider multiple theoretical frameworks

## Lessons Learned
[Refine based on experience]
`,
        description: 'Research approach refined over time',
      },
    ],
    allowedTools: ['Read', 'Write'],
    permissionMode: 'unrestricted',
  }, client);
}

/**
 * Have the presenter pick a topic and research it
 */
export async function pickTopicAndResearch(
  session: LettaCodeSession,
  onOutput: (text: string) => void,
  userTopic?: string
): Promise<{ topic: string; presentation: string }> {
  let prompt: string;
  
  if (userTopic) {
    // User provided a topic
    prompt = `## Seminar Preparation

You're preparing for an economics seminar on: **${userTopic}**

Please:

1. **Research the topic** - Use web_search to find:
   - Recent academic papers or studies on this topic
   - Key data points and statistics
   - Different perspectives and debates
   - Policy implications and real-world evidence

2. **Prepare your presentation** - Write a 3-4 paragraph presentation that:
   - States your main thesis/finding
   - Presents supporting evidence from your research
   - Acknowledges limitations and counterarguments
   - Discusses implications

Be thorough in your research - you'll be facing a hostile faculty panel. Start researching, then present your findings.`;
  } else {
    // Let the presenter pick a topic
    prompt = `## Seminar Preparation

You're preparing for an economics seminar. Please:

1. **Pick a compelling research topic** - Choose something you find interesting from one of these areas:
   - Labor economics (wages, employment, automation)
   - Monetary policy (inflation, interest rates, central banking)
   - Development economics (poverty, growth, institutions)
   - Behavioral economics (decision-making, biases, nudges)
   - Trade economics (tariffs, globalization, supply chains)
   - Public economics (taxation, public goods, inequality)

2. **Research the topic** - Use web_search to find:
   - Recent academic papers or studies
   - Key data points and statistics
   - Different perspectives on the issue
   - Policy implications

3. **Prepare your presentation** - Write a 3-4 paragraph presentation that:
   - States your main thesis/finding
   - Presents supporting evidence
   - Acknowledges limitations
   - Discusses implications

Start by announcing your chosen topic, then research it, then present.`;
  }

  await session.send(prompt);
  
  let response = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
      onOutput(msg.content);
    }
  }
  
  // Extract topic and presentation from response
  // The response should contain both the research process and final presentation
  return {
    topic: userTopic || extractTopic(response),
    presentation: response,
  };
}

/**
 * Have the presenter respond to a faculty question
 */
export async function respondToQuestion(
  session: LettaCodeSession,
  facultyName: string,
  facultyTitle: string,
  question: string,
  onOutput: (text: string) => void
): Promise<string> {
  const prompt = `## Faculty Question

**${facultyName}** (${facultyTitle}) asks:

"${question}"

Please respond to this question. Be direct, cite evidence where relevant, and defend your methodology if challenged. Keep your response focused and under 3 paragraphs.`;

  await session.send(prompt);
  
  let response = '';
  for await (const msg of session.stream()) {
    if (msg.type === 'assistant') {
      response += msg.content;
      onOutput(msg.content);
    }
  }
  
  return response;
}

/**
 * Extract topic from research response
 */
function extractTopic(response: string): string {
  // Try to find the topic in the response
  const topicMatch = response.match(/topic[:\s]+["']?([^"'\n.]+)/i) ||
                     response.match(/research(?:ing)?[:\s]+["']?([^"'\n.]+)/i) ||
                     response.match(/present(?:ing)?[:\s]+["']?([^"'\n.]+)/i);
  
  if (topicMatch) {
    return topicMatch[1]?.trim() ?? 'Untitled topic';
  }
  
  // Fallback: first sentence
  const firstSentence = response.split(/[.!?]/)[0] ?? '';
  return firstSentence.slice(0, 100) || 'Untitled topic';
}
