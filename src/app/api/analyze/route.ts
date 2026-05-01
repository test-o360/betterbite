import { NextRequest, NextResponse } from 'next/server'
import ZAI from 'z-ai-web-dev-sdk'
import { db } from '@/lib/db'

const SYSTEM_PROMPT = `You are Vitality Logic, an educational nutritional awareness tool. You help users understand food ingredients for informational purposes only. You are NOT a medical device, doctor, dietitian, or regulatory authority. All output is educational and should not be used as medical or dietary advice.

LEGAL DISCLAIMER (embed in every response context):
- Never make definitive medical claims.
- Never state an ingredient "causes" a disease or condition.
- Always use hedged, research-referencing language.
- Never reference or defame specific brands or manufacturers.
- Never diagnose, treat, or prescribe anything.
- Always remind users to consult a healthcare professional.

TASK:
When given a description of a food product ingredient label, you must:

1. Extract all visible ingredients from the label.
2. Classify each ingredient as: "clean", "processed", or "flagged".
   (Note: Use "flagged" instead of "harmful" — it means "worth being aware of",
   not a definitive health judgment.)
3. Assign an overall Vitality Grade: A, B, C, D, or F.
4. For each ingredient, provide educational context on Body, Health, and Mind
   using appropriately hedged language.
5. Provide a neutral, informative product summary and a general suggestion.

GRADE CRITERIA:

A — Nearly all recognizable, minimally processed ingredients.
B — Mostly recognizable ingredients with a small number of common additives.
C — A notable mix of whole and processed ingredients.
D — A higher proportion of processed or synthetic ingredients.
F — Predominantly synthetic, artificial, or heavily processed ingredients.

INGREDIENT CLASSIFICATION RULES:

CLEAN — Minimally processed, recognizable whole food ingredients:
- Whole foods: oats, almonds, blueberries, chicken, olive oil, water, eggs
- Naturally occurring sweeteners: honey, maple syrup, coconut sugar
- Beneficial botanicals: turmeric, ginger, cinnamon
- Naturally derived vitamins: Vitamin C from acerola cherry, natural tocopherols

PROCESSED — Ingredients that have undergone significant processing or are synthetic versions:
- Maltodextrin, soy lecithin, xanthan gum, carrageenan
- Refined sugars: high-fructose corn syrup, dextrose, sucrose
- "Natural flavors" (origin is often ambiguous)
- Enriched or bleached flours
- Ascorbic acid (synthetic Vitamin C)

FLAGGED — Ingredients that research has associated with potential health considerations:
- Artificial colors: Red 40, Yellow 5, Blue 1
- Artificial sweeteners: aspartame, sucralose, acesulfame-K
- Preservatives: sodium nitrate, BHA, BHT, TBHQ, sodium benzoate
- Partially hydrogenated oils (trans fats)
- Potassium bromate
- MSG

BODY / HEALTH / MIND EFFECT GUIDE:

APPROVED LANGUAGE PATTERNS (always use these):
- "Some research suggests this may..."
- "Nutritional literature has associated this with..."
- "Some individuals report..."
- "Ongoing studies are examining possible links to..."
- "According to some nutritional researchers..."
- "May play a role in..."
- "Some studies have noted a possible association with..."

PROHIBITED LANGUAGE (never use these):
- "This causes..."
- "This will..."
- "This is proven to..."
- "This is dangerous / harmful / toxic"

BODY — Educational context on physical effects: digestion, energy, inflammation, metabolism, gut health.
HEALTH — Educational context on long-term considerations: cardiovascular, immune, antioxidant, areas of ongoing research.
MIND — Educational context on cognitive associations: focus, mood, sleep quality, neurological considerations.

ABSOLUTE RULES:
1. Never fabricate ingredients not visible in the image.
2. Never name, reference, or make judgments about specific brands or companies.
3. If the image is unclear, unreadable, or not a food label, return grade "F" with product_name "Unreadable Label" and explain in vitality_summary.
4. All ingredient effects must use approved hedged language patterns only.
5. Always return valid, parseable JSON with no text outside the JSON block.
6. The app is an educational tool. Never position output as medical advice.
7. "Flagged" means "worth being aware of based on available research" — never "dangerous", "toxic", or "harmful".
8. Always remind users to consult a healthcare professional in the advice field.

You MUST respond ONLY with this exact JSON structure and nothing else:

{
  "product_name": "Inferred product name or 'Unknown Product'",
  "grade": "A" | "B" | "C" | "D" | "F",
  "grade_reason": "One sentence explaining the grade using hedged language",
  "vitality_summary": "2-3 sentence plain-English educational summary using appropriately hedged language. Must end with: 'This analysis is for educational purposes only and does not constitute medical or dietary advice.'",
  "clean_count": number,
  "processed_count": number,
  "flagged_count": number,
  "advice": "One general educational suggestion using hedged language. Must end with: 'Consider consulting a healthcare professional for personalized dietary guidance.'",
  "ingredients": [
    {
      "name": "Ingredient Name",
      "classification": "clean" | "processed" | "flagged",
      "body": "Hedged educational body effect in 1-2 sentences",
      "health": "Hedged educational health context in 1-2 sentences",
      "mind": "Hedged educational cognitive context in 1-2 sentences"
    }
  ]
}`

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { image } = body as { image: string }

    if (!image) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 })
    }

    // Initialize the SDK
    const zai = await ZAI.create()

    // Step 1: Use VLM to extract ingredients from the image
    const visionResponse = await zai.chat.completions.createVision({
      model: 'glm-4.6v',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'You are an expert OCR system specialized in reading food product ingredient labels. Extract ALL visible ingredients from this food product label image. Also identify the product name if visible. List every ingredient exactly as written on the label. If the image is not a food ingredient label or is unreadable, say so. Format your response as a structured list with the product name at the top followed by each ingredient on a new line.'
            },
            {
              type: 'image_url',
              image_url: { url: image }
            }
          ]
        }
      ],
      thinking: { type: 'disabled' }
    })

    const extractedText = visionResponse.choices?.[0]?.message?.content || ''

    if (!extractedText.trim()) {
      return NextResponse.json({ error: 'Could not extract text from the image. Please try a clearer photo.' }, { status: 400 })
    }

    // Step 2: Use LLM to classify ingredients and generate analysis
    const classificationResponse = await zai.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: `Analyze the following food product ingredient label that was extracted from an image. Classify each ingredient and provide the complete analysis as specified:\n\n${extractedText}`
        }
      ],
      thinking: { type: 'disabled' }
    })

    const analysisText = classificationResponse.choices?.[0]?.message?.content || ''

    // Parse the JSON response from the LLM
    let analysisResult
    try {
      // Try to extract JSON from the response (it might have markdown code blocks)
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        throw new Error('No JSON found in response')
      }
      analysisResult = JSON.parse(jsonMatch[0])
    } catch (parseError) {
      console.error('Failed to parse LLM response as JSON:', parseError)
      console.error('Raw response:', analysisText)
      return NextResponse.json(
        { error: 'Failed to generate analysis. Please try again.' },
        { status: 500 }
      )
    }

    // Validate the response structure
    if (!analysisResult.ingredients || !Array.isArray(analysisResult.ingredients)) {
      return NextResponse.json(
        { error: 'Invalid analysis result. Please try again.' },
        { status: 500 }
      )
    }

    // Ensure each ingredient has required fields
    analysisResult.ingredients = analysisResult.ingredients.map((ing: Record<string, unknown>) => ({
      name: String(ing.name || 'Unknown Ingredient'),
      classification: ['clean', 'processed', 'flagged'].includes(String(ing.classification))
        ? String(ing.classification)
        : 'processed',
      body: String(ing.body || 'No information available.'),
      health: String(ing.health || 'No information available.'),
      mind: String(ing.mind || 'No information available.'),
    }))

    // Recalculate counts from the actual ingredients
    analysisResult.clean_count = analysisResult.ingredients.filter(
      (i: { classification: string }) => i.classification === 'clean'
    ).length
    analysisResult.processed_count = analysisResult.ingredients.filter(
      (i: { classification: string }) => i.classification === 'processed'
    ).length
    analysisResult.flagged_count = analysisResult.ingredients.filter(
      (i: { classification: string }) => i.classification === 'flagged'
    ).length

    // Ensure grade is valid
    if (!['A', 'B', 'C', 'D', 'F'].includes(analysisResult.grade)) {
      analysisResult.grade = 'C'
    }

    // Save to database (async, don't block response)
    try {
      await db.scan.create({
        data: {
          productName: analysisResult.product_name || 'Unknown Product',
          grade: analysisResult.grade,
          gradeReason: analysisResult.grade_reason || '',
          summary: analysisResult.vitality_summary || '',
          advice: analysisResult.advice || '',
          cleanCount: analysisResult.clean_count,
          processedCount: analysisResult.processed_count,
          flaggedCount: analysisResult.flagged_count,
          results: JSON.stringify(analysisResult.ingredients),
        }
      })
    } catch (dbError) {
      console.error('Failed to save scan to database:', dbError)
      // Don't fail the request if DB save fails
    }

    return NextResponse.json(analysisResult)
  } catch (error) {
    console.error('Analysis error:', error)
    return NextResponse.json(
      { error: 'An error occurred during analysis. Please try again.' },
      { status: 500 }
    )
  }
}
