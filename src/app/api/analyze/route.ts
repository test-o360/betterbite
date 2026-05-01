import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { db } from '@/lib/db'

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

function getGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured. Please add it to your environment variables.')
  }
  return new GoogleGenerativeAI(apiKey)
}

async function analyzeWithRetry(
  options: { image?: string; ingredients?: string },
  maxRetries = 2
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null
  const genAI = getGeminiClient()

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retry attempt ${attempt} for analysis...`)
      }

      // Use Gemini 2.0 Flash — fast and supports vision
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

      let prompt: string
      let imageParts: Array<{ inlineData: { data: string; mimeType: string } }> = []

      if (options.image) {
        // Image mode: read the label AND classify in one call (faster)
        // Parse base64 data from data URL
        const dataUrlMatch = options.image.match(/^data:(image\/\w+);base64,(.+)$/)
        if (!dataUrlMatch) {
          throw new Error('Invalid image data format')
        }

        const mimeType = dataUrlMatch[1]
        const base64Data = dataUrlMatch[2]

        imageParts = [{
          inlineData: { data: base64Data, mimeType }
        }]

        prompt = `Look at this food product ingredient label image. If this is NOT a food label or is unreadable, respond with exactly: NOT_A_FOOD_LABEL

If it IS a food label, read the product name and ALL ingredients from the image, then analyze them.

${ANALYSIS_PROMPT}`
      } else if (options.ingredients) {
        // Text mode: just classify
        prompt = `Analyze these ingredients from a food product.

${ANALYSIS_PROMPT}

Ingredients: ${options.ingredients}`
      } else {
        throw new Error('No image or ingredients provided')
      }

      const result = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            ...imageParts,
          ]
        }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        }
      })

      const responseText = result.response.text()

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

      // Don't retry for non-food-label or config errors
      if (lastError.message === 'NOT_A_FOOD_LABEL' || lastError.message.includes('GEMINI_API_KEY')) {
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

    // Save to database (non-blocking, graceful on Vercel)
    try {
      await db.scan.create({
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
    } catch (dbError) {
      // DB save is optional — don't fail the request
      console.error('DB save skipped:', dbError instanceof Error ? dbError.message : 'DB unavailable')
    }

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
