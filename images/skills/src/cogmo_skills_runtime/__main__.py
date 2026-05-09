"""Entry point for `python3 -u -m cogmo_skills_runtime`.

Runs the supervisor's main loop. Returns when stdin closes.
"""

from cogmo_skills_runtime.supervisor import main

if __name__ == "__main__":
    main()
