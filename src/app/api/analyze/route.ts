import { NextRequest, NextResponse } from 'next/server'
import { dbWrite } from '@/lib/db'

export const maxDuration = 120 // 2 minutes timeout for AI processing

const ANALYSIS_PROMPT = `You are BetterBite, an educational nutritional awareness tool. You help users understand food ingredients for informational purposes only. You are NOT a medical device, doctor, dietitian, or regulatory authority. All output is educational and should not be used as medical or dietary advice.

LEGAL DISCLAIMER:
- Never make definitive medical claims.
- Never state an ingredient "causes" a disease or condition.
- Always use hedged, research-referencing language.
- Never reference or defame specific brands or manufacturers.
- Never diagnose, treat, or prescribe anything.
- Always remind users to consult a healthcare professional.

GRADE CRITERIA:
A — Nearly all recognizable, minimally processed ingredients.
B — Mostly recognizable with a small number of common additives.
C — A notable mix of whole and processed ingredients.
D — A higher proportion of processed or synthetic ingredients.
F — Predominantly synthetic, artificial, or heavily processed ingredients.

CLASSIFICATION RULES:
CLEAN — Minimally processed, recognizable whole food ingredients (oats, almonds, olive oil, water, honey, turmeric, etc.)
PROCESSED — Significantly processed or synthetic versions (maltodextrin, soy lecithin, xanthan gum, refined sugars, "natural flavors", enriched flours, ascorbic acid)
FLAGGED — Associated with potential health considerations in research (artificial colors like Red 40/Yellow 5, artificial sweeteners like aspartame/sucralose, preservatives like BHA/BHT/TBHQ/sodium benzoate, trans fats, potassium bromate, MSG)

HEDGED LANGUAGE (ALWAYS USE):
- "Some research suggests this may..."
- "Nutritional literature has associated this with..."
- "Some individuals report..."
- "Ongoing studies are examining possible links to..."
- "According to some nutritional researchers..."
- "May play a role in..."

NEVER USE:
- "This causes..." / "This will..." / "This is proven to..." / "This is dangerous/harmful/toxic"

Respond ONLY with valid raw JSON (no markdown, no code blocks, no extra text):
{"product_name":"string","grade":"A|B|C|D|F","grade_reason":"one sentence hedged explanation","vitality_summary":"2-3 sentence hedged summary ending with: This analysis is for educational purposes only and does not constitute medical or dietary advice.","clean_count":0,"processed_count":0,"flagged_count":0,"advice":"one hedged suggestion ending with: Consider consulting a healthcare professional for personalized dietary guidance.","ingredients":[{"name":"string","classification":"clean|processed|flagged","body":"1-2 sentence hedged body effect","health":"1-2 sentence hedged health context","mind":"1-2 sentence hedged mind context"}]}`

/* ------------------------------------------------------------------ */
/*  AI Provider: z-ai-web-dev-sdk (primary) + NVIDIA (fallback)       */
/* ------------------------------------------------------------------ */

// z-ai config — works locally via .z-ai-config file, on Vercel via env vars
const ZAI_BASE_URL = process.env.ZAI_BASE_URL || ''
const ZAI_API_KEY = process.env.ZAI_API_KEY || ''
const ZAI_TOKEN = process.env.ZAI_TOKEN || ''
const ZAI_USER_ID = process.env.ZAI_USER_ID || ''

// NVIDIA config — fallback for Vercel deployments
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || ''
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
const NVIDIA_TEXT_MODEL = process.env.NVIDIA_TEXT_MODEL || 'z-ai/glm-5.1'
const NVIDIA_VISION_MODEL = process.env.NVIDIA_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct'

/**
 * Detect which AI provider to use:
 * 1. z-ai-web-dev-sdk (if config file exists OR env vars set)
 * 2. NVIDIA API (if NVIDIA_API_KEY is set)
 */
async function getAIProvider(): Promise<'zai' | 'nvidia'> {
  if (ZAI_BASE_URL && ZAI_API_KEY) return 'zai'
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    const os = await import('os')
    const configPaths = [
      path.join(process.cwd(), '.z-ai-config'),
      path.join(os.homedir(), '.z-ai-config'),
      '/etc/.z-ai-config'
    ]
    for (const p of configPaths) {
      try {
        const str = await fs.readFile(p, 'utf-8')
        const cfg = JSON.parse(str)
        if (cfg.baseUrl && cfg.apiKey) return 'zai'
      } catch { /* continue */ }
    }
  } catch { /* fs not available */ }
  if (NVIDIA_API_KEY) return 'nvidia'
  throw new Error('No AI provider configured. Set ZAI_BASE_URL+ZAI_API_KEY env vars or NVIDIA_API_KEY.')
}

/* ------------------------------------------------------------------ */
/*  z-ai-web-dev-sdk API calls                                         */
/* ------------------------------------------------------------------ */

interface ZAIConfig {
  baseUrl: string
  apiKey: string
  chatId?: string
  userId?: string
  token?: string
}

async function loadZAIConfig(): Promise<ZAIConfig> {
  // 1. From env vars (Vercel)
  if (ZAI_BASE_URL && ZAI_API_KEY) {
    return {
      baseUrl: ZAI_BASE_URL,
      apiKey: ZAI_API_KEY,
      userId: ZAI_USER_ID || undefined,
      token: ZAI_TOKEN || undefined,
    }
  }
  // 2. From config file (local/sandbox)
  const fs = await import('fs/promises')
  const path = await import('path')
  const os = await import('os')
  const configPaths = [
    path.join(process.cwd(), '.z-ai-config'),
    path.join(os.homedir(), '.z-ai-config'),
    '/etc/.z-ai-config'
  ]
  for (const p of configPaths) {
    try {
      const str = await fs.readFile(p, 'utf-8')
      const cfg = JSON.parse(str)
      if (cfg.baseUrl && cfg.apiKey) return cfg
    } catch { /* continue */ }
  }
  throw new Error('z-ai config not found')
}

async function callZAIText(messages: Array<{ role: string; content: string }>): Promise<string> {
  const config = await loadZAIConfig()
  const url = `${config.baseUrl}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
    'X-Z-AI-From': 'Z',
  }
  if (config.chatId) headers['X-Chat-Id'] = config.chatId
  if (config.userId) headers['X-User-Id'] = config.userId
  if (config.token) headers['X-Token'] = config.token

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages,
      temperature: 0.3,
      max_tokens: 4096,
      thinking: { type: 'disabled' },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error(`z-ai text API error (${response.status}):`, errorBody.substring(0, 500))
    throw new Error(`z-ai API returned ${response.status}: ${errorBody.substring(0, 300)}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content?.trim()) throw new Error('z-ai API returned empty content')
  return content
}

async function callZAIVision(
  textPrompt: string,
  imageDataUrl: string
): Promise<string> {
  const config = await loadZAIConfig()
  const url = `${config.baseUrl}/chat/completions/vision`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
    'X-Z-AI-From': 'Z',
  }
  if (config.chatId) headers['X-Chat-Id'] = config.chatId
  if (config.userId) headers['X-User-Id'] = config.userId
  if (config.token) headers['X-Token'] = config.token

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'default',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: textPrompt },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0.3,
      max_tokens: 4096,
      thinking: { type: 'disabled' },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error(`z-ai vision API error (${response.status}):`, errorBody.substring(0, 500))
    throw new Error(`z-ai Vision API returned ${response.status}: ${errorBody.substring(0, 300)}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content?.trim()) throw new Error('z-ai Vision API returned empty content')
  return content
}

/* ------------------------------------------------------------------ */
/*  NVIDIA API calls (fallback for Vercel)                             */
/* ------------------------------------------------------------------ */

interface NvidiaChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | Array<{
    type: 'text' | 'image_url'
    text?: string
    image_url?: { url: string }
  }>
}

async function callNvidiaChat(
  messages: NvidiaChatMessage[],
  model: string
): Promise<string> {
  const url = `${NVIDIA_BASE_URL}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${NVIDIA_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 4096,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error(`NVIDIA API error (${response.status}) model=${model}:`, errorBody.substring(0, 500))
    throw new Error(`NVIDIA API returned ${response.status} for model ${model}: ${errorBody.substring(0, 300)}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content?.trim()) throw new Error('NVIDIA API returned empty content')
  return content
}

/* ------------------------------------------------------------------ */
/*  JSON Extraction                                                     */
/* ------------------------------------------------------------------ */

function extractJSON(text: string): string | null {
  // 1. Try direct parse
  try { JSON.parse(text); return text } catch { /* continue */ }

  // 2. Try markdown code block extraction
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (codeBlockMatch) {
    try { JSON.parse(codeBlockMatch[1]); return codeBlockMatch[1] } catch { /* continue */ }
  }

  // 3. Find balanced braces — the outermost valid JSON object
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i
      depth++
    } else if (text[i] === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        const candidate = text.substring(start, i + 1)
        try { JSON.parse(candidate); return candidate } catch { /* continue */ }
      }
    }
  }

  // 4. Greedy regex fallback
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try { JSON.parse(jsonMatch[0]); return jsonMatch[0] } catch { /* continue */ }
  }

  return null
}

/* ------------------------------------------------------------------ */
/*  Analysis with Retry                                                 */
/* ------------------------------------------------------------------ */

async function analyzeWithRetry(
  options: { image?: string; ingredients?: string },
  maxRetries = 2
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null
  const provider = await getAIProvider()
  const isImageMode = !!options.image

  console.log(`Using AI provider: ${provider}, mode: ${isImageMode ? 'image' : 'text'}`)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retry attempt ${attempt} for analysis (provider: ${provider})...`)
      }

      let responseText: string

      if (provider === 'zai') {
        // --- z-ai-web-dev-sdk path ---
        if (isImageMode) {
          // Vision: send image + prompt to vision endpoint
          const visionPrompt = `Look at this food product ingredient label image. If this is NOT a food label or is unreadable, respond with exactly: NOT_A_FOOD_LABEL\n\nIf it IS a food label, read the product name and ALL ingredients from the image, then analyze them.\n\n${ANALYSIS_PROMPT}`
          responseText = await callZAIVision(visionPrompt, options.image!)
        } else {
          // Text: send ingredients to chat endpoint
          const messages = [
            { role: 'user' as const, content: `Analyze these ingredients from a food product.\n\n${ANALYSIS_PROMPT}\n\nIngredients: ${options.ingredients}` }
          ]
          responseText = await callZAIText(messages)
        }
      } else {
        // --- NVIDIA API path ---
        if (isImageMode) {
          const messages: NvidiaChatMessage[] = [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Look at this food product ingredient label image. If this is NOT a food label or is unreadable, respond with exactly: NOT_A_FOOD_LABEL\n\nIf it IS a food label, read the product name and ALL ingredients from the image, then analyze them.\n\n${ANALYSIS_PROMPT}`
                },
                {
                  type: 'image_url',
                  image_url: { url: options.image! }
                }
              ]
            }
          ]
          responseText = await callNvidiaChat(messages, NVIDIA_VISION_MODEL)
        } else {
          const messages: NvidiaChatMessage[] = [
            { role: 'user', content: `Analyze these ingredients from a food product.\n\n${ANALYSIS_PROMPT}\n\nIngredients: ${options.ingredients}` }
          ]
          responseText = await callNvidiaChat(messages, NVIDIA_TEXT_MODEL)
        }
      }

      if (!responseText.trim()) {
        throw new Error('AI returned empty response')
      }

      // Check for non-food-label response
      if (responseText.toLowerCase().includes('not_a_food_label')) {
        throw new Error('NOT_A_FOOD_LABEL')
      }

      // Extract and parse JSON
      const jsonStr = extractJSON(responseText)
      if (!jsonStr) {
        console.error('Failed to extract JSON. Raw response (first 300):', responseText.substring(0, 300))
        throw new Error('Could not parse analysis results')
      }

      const analysisResult = JSON.parse(jsonStr)

      // Validate structure
      if (!analysisResult.ingredients || !Array.isArray(analysisResult.ingredients) || analysisResult.ingredients.length === 0) {
        throw new Error('Invalid analysis structure - no ingredients found')
      }

      return analysisResult

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry for non-retriable errors
      if (
        lastError.message === 'NOT_A_FOOD_LABEL' ||
        lastError.message.includes('No AI provider configured') ||
        lastError.message.includes('429') ||
        lastError.message.includes('quota')
      ) {
        throw lastError
      }

      console.error(`Attempt ${attempt + 1} failed:`, lastError.message)

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
      }
    }
  }

  throw lastError || new Error('All retry attempts failed')
}

/* ------------------------------------------------------------------ */
/*  POST Handler                                                        */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { image, ingredients } = body as { image?: string; ingredients?: string }

    // Validate: must have either image or ingredients text
    if (!image && !ingredients?.trim()) {
      return NextResponse.json({ error: 'Please provide an image or type the ingredients.' }, { status: 400 })
    }

    // Validate image data format if provided
    if (image && !image.startsWith('data:image/') && !image.startsWith('http')) {
      return NextResponse.json({ error: 'Invalid image format. Please upload a valid image.' }, { status: 400 })
    }

    // Run analysis with retry
    let analysisResult: Record<string, unknown>
    try {
      analysisResult = await analyzeWithRetry({
        image: image || undefined,
        ingredients: ingredients?.trim() || undefined,
      }, 2)
    } catch (analysisError) {
      const errMsg = analysisError instanceof Error ? analysisError.message : 'Unknown error'

      if (errMsg === 'NOT_A_FOOD_LABEL') {
        return NextResponse.json(
          { error: 'The image does not appear to be a food ingredient label. Please upload a clear photo of a food product ingredient list.' },
          { status: 400 }
        )
      }

      if (errMsg.includes('No AI provider configured')) {
        return NextResponse.json(
          { error: 'AI service is not configured. Please set the required API keys in your environment variables.' },
          { status: 500 }
        )
      }

      console.error('All analysis attempts failed:', errMsg)

      // User-friendly message for quota errors
      if (errMsg.includes('429') || errMsg.includes('quota')) {
        return NextResponse.json(
          { error: 'The AI service quota has been exceeded. Please wait a moment and try again.' },
          { status: 429 }
        )
      }

      return NextResponse.json(
        { error: 'Analysis could not be completed. Please try again.' },
        { status: 500 }
      )
    }

    // Normalize and validate each ingredient
    const normalizedIngredients = (analysisResult.ingredients as Record<string, unknown>[]).map((ing) => ({
      name: String(ing.name || 'Unknown Ingredient'),
      classification: ['clean', 'processed', 'flagged'].includes(String(ing.classification))
        ? String(ing.classification)
        : 'processed',
      body: String(ing.body || 'No information available.'),
      health: String(ing.health || 'No information available.'),
      mind: String(ing.mind || 'No information available.'),
    }))

    // Recalculate counts
    const clean_count = normalizedIngredients.filter(i => i.classification === 'clean').length
    const processed_count = normalizedIngredients.filter(i => i.classification === 'processed').length
    const flagged_count = normalizedIngredients.filter(i => i.classification === 'flagged').length

    // Validate grade
    const grade = ['A', 'B', 'C', 'D', 'F'].includes(String(analysisResult.grade))
      ? String(analysisResult.grade)
      : 'C'

    const product_name = String(analysisResult.product_name || 'Unknown Product')
    const grade_reason = String(analysisResult.grade_reason || '')
    const vitality_summary = String(analysisResult.vitality_summary || '')
    const advice = String(analysisResult.advice || '')

    // Save to database (graceful — won't crash on Vercel/serverless)
    await dbWrite('scan', 'create', {
      data: {
        productName: product_name,
        grade,
        gradeReason: grade_reason,
        summary: vitality_summary,
        advice,
        cleanCount: clean_count,
        processedCount: processed_count,
        flaggedCount: flagged_count,
        source: image ? 'scan' : 'manual',
        results: JSON.stringify(normalizedIngredients),
      }
    })

    return NextResponse.json({
      product_name,
      grade,
      grade_reason,
      vitality_summary,
      clean_count,
      processed_count,
      flagged_count,
      advice,
      ingredients: normalizedIngredients,
    })
  } catch (error) {
    console.error('Route handler error:', error)
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
