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
/*  Gemini REST API (direct fetch — works on all serverless runtimes)  */
/* ------------------------------------------------------------------ */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1/models'

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY
  if (!key) {
    throw new Error('GEMINI_API_KEY is not configured. Please add it to your environment variables.')
  }
  return key
}

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

interface GeminiRequest {
  contents: Array<{
    role: string
    parts: GeminiPart[]
  }>
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
  }
}

async function callGemini(
  model: string,
  request: GeminiRequest,
  apiKey: string
): Promise<string> {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    console.error(`Gemini API error (${response.status}):`, errorBody.substring(0, 500))
    throw new Error(`Gemini API returned ${response.status}: ${errorBody.substring(0, 200)}`)
  }

  const data = await response.json()

  // Extract text from response
  const candidates = data.candidates
  if (!candidates || candidates.length === 0) {
    const blockReason = data.promptFeedback?.blockReason
    if (blockReason) {
      throw new Error(`Gemini blocked the request: ${blockReason}`)
    }
    throw new Error('Gemini returned no candidates')
  }

  const content = candidates[0].content
  if (!content || !content.parts || content.parts.length === 0) {
    throw new Error('Gemini returned empty content')
  }

  const textParts = content.parts
    .filter((p: GeminiPart) => p.text)
    .map((p: GeminiPart) => p.text)
    .join('')

  if (!textParts.trim()) {
    throw new Error('Gemini returned empty text')
  }

  return textParts
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
  const apiKey = getApiKey()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retry attempt ${attempt} for analysis...`)
      }

      let prompt: string
      let parts: GeminiPart[] = []

      if (options.image) {
        // Image mode: read the label AND classify in one call
        const dataUrlMatch = options.image.match(/^data:(image\/\w+);base64,(.+)$/)
        if (!dataUrlMatch) {
          throw new Error('Invalid image data format')
        }

        const mimeType = dataUrlMatch[1]
        const base64Data = dataUrlMatch[2]

        parts.push({ text: `Look at this food product ingredient label image. If this is NOT a food label or is unreadable, respond with exactly: NOT_A_FOOD_LABEL

If it IS a food label, read the product name and ALL ingredients from the image, then analyze them.

${ANALYSIS_PROMPT}` })

        parts.push({ inlineData: { mimeType, data: base64Data } })
      } else if (options.ingredients) {
        // Text mode: just classify
        prompt = `Analyze these ingredients from a food product.

${ANALYSIS_PROMPT}

Ingredients: ${options.ingredients}`

        parts.push({ text: prompt })
      } else {
        throw new Error('No image or ingredients provided')
      }

      // Use Gemini 2.0 Flash — fast and capable
      const responseText = await callGemini('gemini-2.0-flash', {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        }
      }, apiKey)

      if (!responseText.trim()) {
        throw new Error('Gemini returned empty response')
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
        lastError.message.includes('GEMINI_API_KEY') ||
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

      if (errMsg.includes('GEMINI_API_KEY')) {
        return NextResponse.json(
          { error: 'AI service is not configured. Please contact the administrator.' },
          { status: 500 }
        )
      }

      console.error('All analysis attempts failed:', errMsg)

      // User-friendly message for quota errors
      if (errMsg.includes('429') || errMsg.includes('quota')) {
        return NextResponse.json(
          { error: 'The AI service quota has been exceeded. Please wait a minute and try again, or check your Gemini API plan and billing details.' },
          { status: 429 }
        )
      }

      return NextResponse.json(
        { error: `Analysis could not be completed: ${errMsg}` },
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
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: `An unexpected error occurred: ${message}. Please try again.` },
      { status: 500 }
    )
  }
}
