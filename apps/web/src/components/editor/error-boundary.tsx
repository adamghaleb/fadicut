"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../ui/button";

interface EditorErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
}

interface EditorErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}

export class EditorErrorBoundary extends Component<
	EditorErrorBoundaryProps,
	EditorErrorBoundaryState
> {
	constructor(props: EditorErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error): EditorErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("Editor panel error:", error, info.componentStack);
	}

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) return this.props.fallback;

			return (
				<div className="flex h-full w-full items-center justify-center rounded-sm border border-dashed border-muted-foreground/20 bg-background p-4">
					<div className="flex flex-col items-center gap-3 text-center">
						<p className="text-sm font-medium text-foreground">
							Something went wrong
						</p>
						<p className="max-w-xs text-xs text-muted-foreground">
							{this.state.error?.message || "An unexpected error occurred"}
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => this.setState({ hasError: false, error: null })}
						>
							Retry
						</Button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
