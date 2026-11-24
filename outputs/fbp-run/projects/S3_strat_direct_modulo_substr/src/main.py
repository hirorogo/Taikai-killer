def fizzbuzz_plus(n: int) -> str:
    s = str(n)
    fizz = (n % 3 == 0) or ('3' in s)
    buzz = (n % 5 == 0) or ('5' in s)
    if fizz and buzz:
        return "FizzBuzz"
    if fizz:
        return "Fizz"
    if buzz:
        return "Buzz"
    return s
