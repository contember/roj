import { useCallback, useEffect, useRef, useState } from 'react'
import { type PendingAttachment, useSessionStore } from '../../stores/session-store.js'

interface MessageInputProps {
	disabled?: boolean
}

export function MessageInput({ disabled }: MessageInputProps) {
	const [content, setContent] = useState('')
	const [isDragging, setIsDragging] = useState(false)
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const sendMessage = useSessionStore((s) => s.sendMessage)
	const uploadFile = useSessionStore((s) => s.uploadFile)
	const removeAttachment = useSessionStore((s) => s.removeAttachment)
	const pendingAttachments = useSessionStore((s) => s.pendingAttachments)

	const attachments = Array.from(pendingAttachments.values())
	const hasReadyAttachments = attachments.some((a) => a.status === 'ready')
	const hasUploadingAttachments = attachments.some((a) => a.status === 'uploading')

	const canSubmit = !disabled && !hasUploadingAttachments && (content.trim() || hasReadyAttachments)

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!canSubmit) return

		sendMessage(content.trim())
		setContent('')
	}

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleSubmit(e)
		}
	}

	const handleFiles = useCallback((files: FileList | null) => {
		if (!files) return
		for (const file of files) {
			uploadFile(file)
		}
	}, [uploadFile])

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setIsDragging(true)
	}, [])

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setIsDragging(false)
	}, [])

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		e.stopPropagation()
		setIsDragging(false)
		handleFiles(e.dataTransfer.files)
	}, [handleFiles])

	const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		handleFiles(e.target.files)
		e.target.value = ''
	}

	// Auto-resize textarea (content dep is intentional — re-measure on every keystroke)
	// biome-ignore lint/correctness/useExhaustiveDependencies: content triggers resize
	useEffect(() => {
		const textarea = textareaRef.current
		if (textarea) {
			textarea.style.height = 'auto'
			const newHeight = Math.min(textarea.scrollHeight, 200)
			textarea.style.height = `${newHeight}px`
			textarea.style.overflowY = textarea.scrollHeight > 200 ? 'auto' : 'hidden'
		}
	}, [content])

	return (
		<div
			className={`relative transition-all ${isDragging ? 'ring-2 ring-violet-300/50 ring-offset-2 rounded-2xl' : ''}`}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{/* Drag overlay */}
			{isDragging && (
				<div className="absolute inset-0 bg-violet-50/80 border-2 border-dashed border-violet-300 rounded-2xl flex items-center justify-center z-10 backdrop-blur-sm">
					<p className="text-sm text-violet-600 font-medium">Drop files here</p>
				</div>
			)}

			{/* Pending attachments */}
			{attachments.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mb-2">
					{attachments.map((attachment) => (
						<AttachmentChip
							key={attachment.uploadId}
							attachment={attachment}
							onRemove={() => removeAttachment(attachment.uploadId)}
						/>
					))}
				</div>
			)}

			<form onSubmit={handleSubmit} className="flex items-end gap-2 bg-surface-raised border border-border/60 rounded-2xl px-3 py-2 shadow-sm focus-within:border-violet-200 focus-within:shadow-md focus-within:shadow-violet-500/[0.04] transition-all">
				{/* File input button */}
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					disabled={disabled}
					className="p-1.5 rounded-lg text-muted-foreground/40 hover:text-foreground hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
					title="Attach file"
				>
					<svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
					</svg>
				</button>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					onChange={handleFileInputChange}
					className="hidden"
					accept="image/*,application/pdf,.docx,.txt,.md,.zip"
				/>

				<textarea
					ref={textareaRef}
					value={content}
					onChange={(e) => setContent(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={attachments.length > 0 ? 'Add a message (optional)...' : 'Type a message...'}
					disabled={disabled}
					rows={1}
					className="flex-1 py-1 resize-none overflow-hidden text-sm focus:outline-none disabled:opacity-40 placeholder:text-muted-foreground/35 bg-transparent"
				/>
				<button
					type="submit"
					disabled={!canSubmit}
					className={`p-1.5 rounded-xl shrink-0 transition-all ${
						canSubmit
							? 'bg-gradient-to-br from-violet-600 to-blue-600 text-white shadow-md shadow-violet-500/20 hover:shadow-lg hover:shadow-violet-500/30 active:scale-95'
							: 'bg-muted text-muted-foreground/30 cursor-not-allowed'
					}`}
				>
					<svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 19V5M5 12l7-7 7 7" />
					</svg>
				</button>
			</form>
		</div>
	)
}

interface AttachmentChipProps {
	attachment: PendingAttachment
	onRemove: () => void
}

function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
	const statusStyles = {
		uploading: 'bg-amber-50 text-amber-700 border-amber-200/80',
		ready: 'bg-emerald-50 text-emerald-700 border-emerald-200/80',
		failed: 'bg-red-50 text-red-700 border-red-200/80',
	}

	return (
		<div
			className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs ${statusStyles[attachment.status]}`}
			title={attachment.error || attachment.filename}
		>
			{attachment.status === 'uploading' && (
				<svg className="animate-spin h-3 w-3" viewBox="0 0 24 24">
					<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
					<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
				</svg>
			)}
			{attachment.status === 'ready' && (
				<svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
					<path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
				</svg>
			)}
			{attachment.status === 'failed' && (
				<svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
					<path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
				</svg>
			)}

			<span className="max-w-32 truncate">{attachment.filename}</span>

			<button type="button" onClick={onRemove} className="hover:opacity-60 transition-opacity" title="Remove">
				<svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
					<path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
				</svg>
			</button>
		</div>
	)
}
