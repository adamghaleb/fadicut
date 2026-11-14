"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";

interface ErrorBoundaryProps {
	children: ReactNode;
	fallback?: ReactNode;
}

interface ErrorBoundaryState {
	hasError: boolean;
}

export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(): ErrorBoundaryState {
		return { hasError: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("ErrorBoundary caught:", error, info.componentStack);
	}

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) return this.props.fallback;

			return (
				<div className="flex h-full w-full items-center justify-center p-4">
					<div className="flex flex-col items-center gap-3 text-center">
						<p className="text-muted-foreground text-sm">
							Something went wrong
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => this.setState({ hasError: false })}
						>
							Try again
						</Button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}
