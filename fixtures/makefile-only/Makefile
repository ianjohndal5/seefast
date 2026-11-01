.PHONY: setup run test

setup:
	git submodule update --init
	./configure --prefix=$(PWD)/build

run: setup
	./build/bin/tracker --port 9000

test:
	./run-tests.sh
