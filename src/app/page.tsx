'use client'

import { useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload,
  Camera,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Heart,
  Brain,
  Activity,
  Lightbulb,
  Info,
  RotateCcw,
  X,
  Loader2,
  Leaf,
  ShieldAlert,
  ScanLine,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Ingredient {
  name: string
  classification: 'clean' | 'processed' | 'flagged'
  body: string
  health: string
  mind: string
}

interface AnalysisResult {
  product_name: string
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  grade_reason: string
  vitality_summary: string
  clean_count: number
  processed_count: number
  flagged_count: number
  advice: string
  ingredients: Ingredient[]
}

type Screen = 'scan' | 'results' | 'detail'
type FilterTab = 'all' | 'clean' | 'processed' | 'flagged'

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const GRADE_CONFIG: Record<string, { color: string; bg: string; ring: string; label: string }> = {
  A: { color: 'text-emerald-600', bg: 'bg-emerald-50', ring: 'stroke-emerald-500', label: 'Excellent' },
  B: { color: 'text-green-600', bg: 'bg-green-50', ring: 'stroke-green-500', label: 'Good' },
  C: { color: 'text-amber-600', bg: 'bg-amber-50', ring: 'stroke-amber-500', label: 'Moderate' },
  D: { color: 'text-orange-600', bg: 'bg-orange-50', ring: 'stroke-orange-500', label: 'Low' },
  F: { color: 'text-red-600', bg: 'bg-red-50', ring: 'stroke-red-500', label: 'Poor' },
}

const CLASSIFICATION_CONFIG: Record<string, { color: string; bg: string; icon: typeof CheckCircle2; label: string }> = {
  clean: { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: CheckCircle2, label: 'Clean' },
  processed: { color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', icon: CircleDot, label: 'Processed' },
  flagged: { color: 'text-red-700', bg: 'bg-red-50 border-red-200', icon: AlertTriangle, label: 'Flagged' },
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Home() {
  const [screen, setScreen] = useState<Screen>('scan')
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [selectedIngredient, setSelectedIngredient] = useState<Ingredient | null>(null)
  const [filterTab, setFilterTab] = useState<FilterTab>('all')
  const [error, setError] = useState<string | null>(null)
  const [analyzeProgress, setAnalyzeProgress] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  /* ---- Handlers ---- */

  const compressImage = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      const img = new Image()

      img.onload = () => {
        // Max dimensions for API payload
        const MAX_WIDTH = 1600
        const MAX_HEIGHT = 1600
        let { width, height } = img

        if (width > MAX_WIDTH || height > MAX_HEIGHT) {
          const ratio = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }

        canvas.width = width
        canvas.height = height

        ctx?.drawImage(img, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
        URL.revokeObjectURL(img.src)
        resolve(dataUrl)
      }

      img.onerror = () => {
        URL.revokeObjectURL(img.src)
        reject(new Error('Failed to load image'))
      }

      img.src = URL.createObjectURL(file)
    })
  }, [])

  const handleImageSelect = useCallback(async (file: File) => {
    setError(null)
    try {
      const compressed = await compressImage(file)
      setImagePreview(compressed)
    } catch {
      // Fallback to direct data URL if compression fails
      const reader = new FileReader()
      reader.onload = (e) => {
        setImagePreview(e.target?.result as string)
      }
      reader.readAsDataURL(file)
    }
  }, [compressImage])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleImageSelect(file)
    },
    [handleImageSelect]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files?.[0]
      if (file && file.type.startsWith('image/')) handleImageSelect(file)
    },
    [handleImageSelect]
  )

  const handleAnalyze = useCallback(async () => {
    if (!imagePreview) return
    setAnalyzing(true)
    setError(null)
    setAnalyzeProgress('Scanning label...')

    // Simulate progress updates
    const progressTimer = setInterval(() => {
      setAnalyzeProgress(prev => {
        if (prev === 'Scanning label...') return 'Reading ingredients...'
        if (prev === 'Reading ingredients...') return 'Classifying ingredients...'
        if (prev === 'Classifying ingredients...') return 'Generating analysis...'
        if (prev === 'Generating analysis...') return 'Almost done...'
        return prev
      })
    }, 8000)

    try {
      const controller = new AbortController()
      // 2 minute timeout for AI analysis
      const timeoutId = setTimeout(() => controller.abort(), 120000)

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imagePreview }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!res.ok) {
        let errorMessage = 'Analysis failed. Please try again.'
        try {
          const errData = await res.json()
          errorMessage = errData.error || errorMessage
        } catch {
          // Use default error message
        }
        throw new Error(errorMessage)
      }

      const data: AnalysisResult = await res.json()

      // Validate the response has expected structure
      if (!data.ingredients || !Array.isArray(data.ingredients) || data.ingredients.length === 0) {
        throw new Error('Analysis returned no ingredients. Please try a clearer photo.')
      }

      setResult(data)
      setScreen('results')
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Analysis timed out. Please try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      }
    } finally {
      clearInterval(progressTimer)
      setAnalyzeProgress('')
      setAnalyzing(false)
    }
  }, [imagePreview])

  const handleIngredientClick = useCallback((ingredient: Ingredient) => {
    setSelectedIngredient(ingredient)
    setScreen('detail')
  }, [])

  const handleRescan = useCallback(() => {
    setScreen('scan')
    setImagePreview(null)
    setResult(null)
    setSelectedIngredient(null)
    setFilterTab('all')
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const handleBack = useCallback(() => {
    if (screen === 'detail') {
      setScreen('results')
    } else if (screen === 'results') {
      setScreen('scan')
      // Keep the result and preview so user can go back,
      // but clear any previous error
      setError(null)
    }
  }, [screen])

  /* ---- Filtered ingredients ---- */

  const filteredIngredients = result?.ingredients.filter((ing) => {
    if (filterTab === 'all') return true
    return ing.classification === filterTab
  }) ?? []

  /* ---- Render ---- */

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-foreground/[0.03] backdrop-blur-xl border-b border-border/50">
        <div className="max-w-lg mx-auto flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-2">
            {screen !== 'scan' && (
              <Button variant="ghost" size="icon" onClick={handleBack} className="size-9">
                <ChevronLeft className="size-5" />
              </Button>
            )}
            <div className="flex items-center gap-2">
              <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Leaf className="size-4 text-primary" />
              </div>
              <span className="font-bold text-lg tracking-tight">Vitality Logic</span>
            </div>
          </div>
          {screen !== 'scan' && (
            <Button variant="ghost" size="icon" onClick={handleRescan} className="size-9">
              <RotateCcw className="size-4" />
            </Button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-6">
        <AnimatePresence mode="wait">
          {screen === 'scan' && (
            <ScanScreen
              key="scan"
              imagePreview={imagePreview}
              analyzing={analyzing}
              analyzeProgress={analyzeProgress}
              error={error}
              fileInputRef={fileInputRef}
              onFileChange={handleFileChange}
              onDrop={handleDrop}
              onAnalyze={handleAnalyze}
              onClearImage={() => { setImagePreview(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
            />
          )}
          {screen === 'results' && result && (
            <ResultsScreen
              key="results"
              result={result}
              filterTab={filterTab}
              filteredIngredients={filteredIngredients}
              onFilterChange={setFilterTab}
              onIngredientClick={handleIngredientClick}
              onRescan={handleRescan}
            />
          )}
          {screen === 'detail' && selectedIngredient && result && (
            <DetailScreen
              key="detail"
              ingredient={selectedIngredient}
              grade={result.grade}
              onIngredientClick={handleIngredientClick}
              ingredients={result.ingredients}
            />
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-border/50 bg-foreground/[0.02] py-4">
        <div className="max-w-lg mx-auto px-4 text-center">
          <p className="text-xs text-muted-foreground">
            For educational purposes only. Not medical advice. Consult a healthcare professional.
          </p>
        </div>
      </footer>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Scan Screen                                                        */
/* ------------------------------------------------------------------ */

function ScanScreen({
  imagePreview,
  analyzing,
  analyzeProgress,
  error,
  fileInputRef,
  onFileChange,
  onDrop,
  onAnalyze,
  onClearImage,
}: {
  imagePreview: string | null
  analyzing: boolean
  analyzeProgress: string
  error: string | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onDrop: (e: React.DragEvent) => void
  onAnalyze: () => void
  onClearImage: () => void
}) {
  const [dragOver, setDragOver] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-6"
    >
      {/* Hero Section */}
      <div className="text-center space-y-2 pt-2">
        <h1 className="text-2xl font-bold tracking-tight">Scan Your Food</h1>
        <p className="text-muted-foreground text-sm">
          Upload a photo of a food ingredient label to analyze its nutritional profile
        </p>
      </div>

      {/* Upload Area */}
      {!imagePreview ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { onDrop(e); setDragOver(false) }}
          className={`
            relative rounded-2xl border-2 border-dashed transition-all duration-300
            ${dragOver ? 'border-primary bg-primary/5 scale-[1.02]' : 'border-border hover:border-primary/50 hover:bg-primary/[0.02]'}
            p-8 flex flex-col items-center justify-center gap-4 min-h-[320px]
          `}
        >
          <div className="size-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Camera className="size-8 text-primary" />
          </div>
          <div className="text-center space-y-1">
            <p className="font-medium">Drag & drop your label image</p>
            <p className="text-sm text-muted-foreground">or use the buttons below</p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 mt-2 w-full max-w-xs">
            <Button
              variant="outline"
              className="flex-1 gap-2"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" />
              Upload
            </Button>
            <Button
              className="flex-1 gap-2"
              onClick={() => fileInputRef.current?.click()}
            >
              <Camera className="size-4" />
              Camera
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onFileChange}
          />
        </div>
      ) : (
        <div className="relative rounded-2xl overflow-hidden border border-border">
          <img
            src={imagePreview}
            alt="Uploaded ingredient label"
            className="w-full max-h-[400px] object-contain bg-foreground/[0.02]"
          />
          <Button
            variant="secondary"
            size="icon"
            className="absolute top-3 right-3 size-8 rounded-full shadow-md"
            onClick={onClearImage}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* Error */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-start gap-2"
        >
          <AlertTriangle className="size-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </motion.div>
      )}

      {/* Analyze Button */}
      {imagePreview && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Button
            className="w-full h-12 text-base gap-2 rounded-xl"
            onClick={onAnalyze}
            disabled={analyzing}
          >
            {analyzing ? (
              <>
                <Loader2 className="size-5 animate-spin" />
                {analyzeProgress || 'Analyzing Ingredients...'}
              </>
            ) : (
              <>
                <Sparkles className="size-5" />
                Analyze Ingredients
              </>
            )}
          </Button>
        </motion.div>
      )}

      {/* Info Card */}
      <Card className="bg-primary/[0.03] border-primary/10">
        <CardContent className="p-4 flex gap-3">
          <Info className="size-5 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-medium">How it works</p>
            <p className="text-xs text-muted-foreground">
              Upload a clear photo of a food product&apos;s ingredient label. Our AI will identify each ingredient,
              classify it, and provide educational context about potential body, health, and mind associations.
            </p>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/*  Results Screen                                                     */
/* ------------------------------------------------------------------ */

function ResultsScreen({
  result,
  filterTab,
  filteredIngredients,
  onFilterChange,
  onIngredientClick,
  onRescan,
}: {
  result: AnalysisResult
  filterTab: FilterTab
  filteredIngredients: Ingredient[]
  onFilterChange: (tab: FilterTab) => void
  onIngredientClick: (ingredient: Ingredient) => void
  onRescan: () => void
}) {
  const gradeConfig = GRADE_CONFIG[result.grade]
  const circumference = 2 * Math.PI * 45
  const gradePercent = result.grade === 'A' ? 95 : result.grade === 'B' ? 80 : result.grade === 'C' ? 60 : result.grade === 'D' ? 40 : 20

  const counts = {
    all: result.ingredients.length,
    clean: result.clean_count,
    processed: result.processed_count,
    flagged: result.flagged_count,
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-5"
    >
      {/* Product Card + Grade */}
      <Card className="overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            {/* Grade Circle */}
            <div className="relative shrink-0">
              <svg width="100" height="100" className="transform -rotate-90">
                <circle
                  cx="50" cy="50" r="45"
                  fill="none"
                  stroke="currentColor"
                  className="text-muted/30"
                  strokeWidth="6"
                />
                <circle
                  cx="50" cy="50" r="45"
                  fill="none"
                  className={gradeConfig.ring}
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference - (gradePercent / 100) * circumference}
                  style={{ transition: 'stroke-dashoffset 1.5s ease-out' }}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className={`text-3xl font-black ${gradeConfig.color}`}>
                  {result.grade}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium">{gradeConfig.label}</span>
              </div>
            </div>

            {/* Product Info */}
            <div className="flex-1 min-w-0 space-y-2">
              <h2 className="font-bold text-lg leading-tight truncate">
                {result.product_name}
              </h2>
              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                {result.grade_reason}
              </p>
              {/* Classification Counts */}
              <div className="flex gap-3 pt-1">
                <div className="flex items-center gap-1">
                  <CheckCircle2 className="size-3.5 text-emerald-600" />
                  <span className="text-xs font-medium">{result.clean_count}</span>
                </div>
                <div className="flex items-center gap-1">
                  <CircleDot className="size-3.5 text-amber-600" />
                  <span className="text-xs font-medium">{result.processed_count}</span>
                </div>
                <div className="flex items-center gap-1">
                  <AlertTriangle className="size-3.5 text-red-600" />
                  <span className="text-xs font-medium">{result.flagged_count}</span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Vitality Summary */}
      <Card className="bg-primary/[0.03] border-primary/10">
        <CardContent className="p-4 flex gap-3">
          <Lightbulb className="size-5 text-primary shrink-0 mt-0.5" />
          <p className="text-sm leading-relaxed">{result.vitality_summary}</p>
        </CardContent>
      </Card>

      {/* Filter Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
        {(['all', 'clean', 'processed', 'flagged'] as FilterTab[]).map((tab) => {
          const isActive = filterTab === tab
          const iconMap = { all: ScanLine, clean: CheckCircle2, processed: CircleDot, flagged: AlertTriangle }
          const colorMap = { all: '', clean: 'emerald', processed: 'amber', flagged: 'red' } as const
          const Icon = iconMap[tab]
          return (
            <button
              key={tab}
              onClick={() => onFilterChange(tab)}
              className={`
                flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium
                transition-all whitespace-nowrap border
                ${isActive
                  ? tab === 'clean' ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    : tab === 'processed' ? 'bg-amber-50 border-amber-200 text-amber-700'
                    : tab === 'flagged' ? 'bg-red-50 border-red-200 text-red-700'
                    : 'bg-primary/10 border-primary/20 text-primary'
                  : 'bg-background border-border text-muted-foreground hover:bg-muted'
                }
              `}
            >
              <Icon className="size-3.5" />
              <span className="capitalize">{tab}</span>
              <span className="text-xs opacity-70">({counts[tab]})</span>
            </button>
          )
        })}
      </div>

      {/* Ingredient List */}
      <div className="flex flex-col gap-2.5">
        {filteredIngredients.map((ingredient, i) => {
          const clsConfig = CLASSIFICATION_CONFIG[ingredient.classification]
          const ClsIcon = clsConfig.icon
          return (
            <motion.div
              key={ingredient.name}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05, duration: 0.25 }}
            >
              <Card
                className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.98]"
                onClick={() => onIngredientClick(ingredient)}
              >
                <CardContent className="p-4 flex items-center gap-3">
                  <div className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${clsConfig.bg}`}>
                    <ClsIcon className={`size-4 ${clsConfig.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{ingredient.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-1">{ingredient.body}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${clsConfig.bg} ${clsConfig.color} border-0`}
                  >
                    {clsConfig.label}
                  </Badge>
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </motion.div>
          )
        })}
      </div>

      {/* Advice */}
      <Card className="bg-vitality-blue/5 border-vitality-blue/10">
        <CardContent className="p-4 flex gap-3">
          <ShieldAlert className="size-5 text-vitality-blue shrink-0 mt-0.5" />
          <p className="text-sm leading-relaxed">{result.advice}</p>
        </CardContent>
      </Card>

      {/* Rescan Button */}
      <Button
        variant="outline"
        className="w-full h-11 gap-2 rounded-xl"
        onClick={onRescan}
      >
        <RotateCcw className="size-4" />
        Scan Another Product
      </Button>
    </motion.div>
  )
}

/* ------------------------------------------------------------------ */
/*  Detail Screen                                                      */
/* ------------------------------------------------------------------ */

function DetailScreen({
  ingredient,
  grade,
  onIngredientClick,
  ingredients,
}: {
  ingredient: Ingredient
  grade: string
  onIngredientClick: (ingredient: Ingredient) => void
  ingredients: Ingredient[]
}) {
  const clsConfig = CLASSIFICATION_CONFIG[ingredient.classification]
  const ClsIcon = clsConfig.icon

  // Related ingredients: same classification, excluding current
  const related = ingredients
    .filter((i) => i.classification === ingredient.classification && i.name !== ingredient.name)
    .slice(0, 5)

  const impactSections = [
    { key: 'body', icon: Activity, label: 'Body', color: 'text-blue-600', bg: 'bg-blue-50', borderColor: 'border-blue-200' },
    { key: 'health', icon: Heart, label: 'Health', color: 'text-rose-600', bg: 'bg-rose-50', borderColor: 'border-rose-200' },
    { key: 'mind', icon: Brain, label: 'Mind', color: 'text-violet-600', bg: 'bg-violet-50', borderColor: 'border-violet-200' },
  ] as const

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-5"
    >
      {/* Ingredient Header */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-start gap-3">
            <div className={`size-12 rounded-xl flex items-center justify-center shrink-0 ${clsConfig.bg}`}>
              <ClsIcon className={`size-6 ${clsConfig.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold">{ingredient.name}</h2>
              <div className="flex items-center gap-2 mt-1.5">
                <Badge className={`${clsConfig.bg} ${clsConfig.color} border-0 text-xs`}>
                  {clsConfig.label}
                </Badge>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* What It Is - Body/Health/Mind Sections */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider px-1">
          Health Impact Report
        </h3>
        {impactSections.map((section) => {
          const Icon = section.icon
          return (
            <Card key={section.key} className={`${section.bg} ${section.borderColor} border`}>
              <CardContent className="p-4 flex gap-3">
                <div className={`size-9 rounded-lg bg-white/80 flex items-center justify-center shrink-0`}>
                  <Icon className={`size-4 ${section.color}`} />
                </div>
                <div className="flex-1 space-y-1">
                  <p className={`font-semibold text-sm ${section.color}`}>{section.label}</p>
                  <p className="text-sm leading-relaxed text-foreground/80">
                    {ingredient[section.key]}
                  </p>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Consumer Tip */}
      <Card className="bg-primary/[0.03] border-primary/10">
        <CardContent className="p-4 flex gap-3">
          <Lightbulb className="size-5 text-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-medium">Educational Note</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              This information is for educational purposes only. Individual responses to ingredients
              may vary. Consider consulting a healthcare professional for personalized dietary guidance.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Related Ingredients */}
      {related.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider px-1">
            Related Ingredients
          </h3>
          <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
            {related.map((relIng) => {
              const relConfig = CLASSIFICATION_CONFIG[relIng.classification]
              const RelIcon = relConfig.icon
              return (
                <button
                  key={relIng.name}
                  onClick={() => onIngredientClick(relIng)}
                  className={`
                    flex items-center gap-2 px-3 py-2 rounded-full text-sm font-medium
                    whitespace-nowrap border transition-all
                    ${relConfig.bg} ${relConfig.color} border-current/20
                    hover:shadow-sm active:scale-95
                  `}
                >
                  <RelIcon className="size-3.5" />
                  {relIng.name}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </motion.div>
  )
}
