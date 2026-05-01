import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
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

async function analyzeWithRetry(
  zai: ZAI,
  options: { image?: string; ingredients?: string },
  maxRetries = 2
): Promise<Record<string, unknown>> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retry attempt ${attempt} for analysis...`)
      }

      let ingredientText: string

      if (options.image) {
        // Step 1: VLM - extract text from image
        const visionResponse = await zai.chat.completions.createVision({
          model: 'glm-4.6v',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Read this food product ingredient label. Extract the product name and list ALL ingredients exactly as written. If not a food label or unreadable, say "NOT_A_FOOD_LABEL".'
                },
                { type: 'image_url', image_url: { url: options.image } }
              ]
            }
          ],
          thinking: { type: 'disabled' }
        })

        ingredientText = visionResponse.choices?.[0]?.message?.content || ''

        if (!ingredientText.trim()) {
          throw new Error('VLM returned empty response')
        }

        // Check if the image was identified as not a food label
        if (ingredientText.toLowerCase().includes('not_a_food_label')) {
          throw new Error('NOT_A_FOOD_LABEL')
        }
      } else if (options.ingredients) {
        // Manual text input mode
        ingredientText = `Ingredients: ${options.ingredients}`
      } else {
        throw new Error('No image or ingredients provided')
      }

      // Step 2: LLM - classify and analyze
      const classificationResponse = await zai.chat.completions.create({
        messages: [
          { role: 'system', content: ANALYSIS_PROMPT },
          {
            role: 'user',
            content: `Analyze these ingredients from a food label. Return ONLY raw JSON:\n\n${ingredientText}`
          }
        ],
        thinking: { type: 'disabled' }
      })

      const analysisText = classificationResponse.choices?.[0]?.message?.content || ''

      if (!analysisText.trim()) {
        throw new Error('LLM returned empty response')
      }

      // Extract and parse JSON
      const jsonStr = extractJSON(analysisText)
      if (!jsonStr) {
        console.error('Failed to extract JSON. Raw response (first 300):', analysisText.substring(0, 300))
        throw new Error('Could not parse analysis results')
      }

      const result = JSON.parse(jsonStr)

      // Validate structure
      if (!result.ingredients || !Array.isArray(result.ingredients) || result.ingredients.length === 0) {
        throw new Error('Invalid analysis structure - no ingredients found')
      }

      return result

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      // Don't retry for non-food-label errors
      if (lastError.message === 'NOT_A_FOOD_LABEL') {
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

    // Initialize the SDK
    const zai = await ZAI.create()

    // Run analysis with retry
    let analysisResult: Record<string, unknown>
    try {
      analysisResult = await analyzeWithRetry(zai, {
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

    // Save to database (non-blocking)
    db.scan.create({
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
    }).catch(dbError => {
      console.error('DB save failed:', dbError)
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
